/**
 * Records what Safe Exam Browser proved about itself.
 *
 * Why this file exists at all: SEB attaches its exam keys to requests for the
 * exam server's own domain. The Windows build sends them nowhere else, so the
 * database — which lives on supabase.co — never sees them and every student on
 * Windows was refused. This endpoint is served from the portal's own domain, so
 * every SEB sends its keys here, whatever the platform.
 *
 * It records what it saw and nothing more. It does not decide whether a student
 * may sit the paper; get_exam() still does that, by comparing the recording
 * with the fingerprint the test learned from a teacher.
 *
 * Two things make a recording trustworthy:
 *
 *   The identity is not ours to choose. The student's own access token is
 *   forwarded untouched, so the database reads the email from the JWT. We
 *   could not attribute a proof to somebody else if we tried.
 *
 *   The secret never reaches the browser. SEB_PROOF_SECRET lives only here and
 *   in the database. A student calling record_seb_proof() straight from the
 *   page has no secret and is refused — which is what stops them fabricating
 *   the very headers this endpoint exists to observe.
 *
 * Environment (set in Vercel):
 *   SEB_PROOF_SECRET  the shared secret, also set via admin_set_seb_secret()
 *   SUPABASE_URL      defaults to VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY defaults to VITE_SUPABASE_ANON_KEY
 */

const HEADERS = {
  configKey: "x-safeexambrowser-configkeyhash",
  requestHash: "x-safeexambrowser-requesthash",
};

const env = name => process.env[name] ?? process.env[`VITE_${name}`] ?? "";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST." });
  }

  const url = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const secret = process.env.SEB_PROOF_SECRET ?? "";

  // What SEB attached to this request. Absent is a normal answer, not an
  // error: an ordinary browser sends nothing, and saying so plainly is more
  // useful than a failure.
  const configKeyHash = request.headers[HEADERS.configKey] ?? null;
  const requestHash = request.headers[HEADERS.requestHash] ?? null;
  const seen = Boolean(configKeyHash || requestHash);

  // Reported so a machine that sends no keys can be diagnosed from the page
  // rather than guessed at. Never the values themselves — those are what a
  // student would need in order to replay them.
  const report = {
    headersSeen: seen,
    configKeyHash: Boolean(configKeyHash),
    requestHash: Boolean(requestHash),
  };

  if (!url || !anonKey) {
    return response.status(500).json({ ...report, recorded: false, error: "Not configured." });
  }
  if (!secret) {
    return response
      .status(200)
      .json({ ...report, recorded: false, error: "SEB_PROOF_SECRET is not set." });
  }

  const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) {
    return response.status(401).json({ ...report, recorded: false, error: "Sign in first." });
  }

  let body = request.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const testId = body?.testId;
  if (!testId) {
    return response.status(400).json({ ...report, recorded: false, error: "testId is required." });
  }

  if (!seen) {
    // Nothing to record. Reported as a success so the page can carry on and
    // let get_exam() decide — this endpoint never blocks anyone by itself.
    return response.status(200).json({ ...report, recorded: false });
  }

  try {
    const result = await fetch(`${url}/rest/v1/rpc/record_seb_proof`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        // The student's own token, forwarded untouched: the database takes the
        // email from the JWT, so this endpoint cannot misattribute a proof.
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_secret: secret,
        p_test_id: testId,
        p_config_key_hash: configKeyHash,
        p_request_hash: requestHash,
        p_user_agent: request.headers["user-agent"] ?? null,
      }),
    });

    const recorded = result.ok && (await result.json()) === true;
    return response.status(200).json({ ...report, recorded });
  } catch (error) {
    console.error("record_seb_proof failed:", error?.message);
    return response.status(200).json({ ...report, recorded: false, error: "Could not record." });
  }
}
