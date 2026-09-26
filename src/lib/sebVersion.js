/**
 * Which version of Safe Exam Browser a machine is running.
 *
 * SEB writes its version into the user agent on every platform:
 *
 *   Mozilla/5.0 (Windows NT 10.0) ... SEB/3.9.0
 *   Mozilla/5.0 (Macintosh) ... SafeExamBrowser/3.4
 *
 * Read this before trusting any of it: a user agent is written by the browser
 * about itself, so a version found here proves nothing about what is really
 * running. This is not a security control and must never be used as one. It
 * exists to catch machines that are genuinely out of date *before* an exam,
 * because an old SEB is the usual reason verification headers never arrive —
 * which otherwise surfaces as a baffling "could not be verified" on the day.
 */

/**
 * The newest release this portal knows about. Bump it when SEB ships a new
 * version; it drives the "your copy is older than the current release" hint,
 * never a refusal.
 */
export const LATEST_SEB = "3.9.0";

/** Where to get a current copy. */
export const SEB_DOWNLOAD = "https://safeexambrowser.org/download_en.html";

/**
 * The version SEB claims, as a plain string like "3.9.0", or null when the
 * user agent carries no SEB marking at all.
 * @param {string} userAgent
 * @returns {string|null}
 */
export function sebVersion(userAgent = "") {
  const match =
    /\bSEB[\s/]v?(\d+(?:\.\d+)*)/i.exec(userAgent) ??
    /\bSafeExamBrowser[\s/]v?(\d+(?:\.\d+)*)/i.exec(userAgent);

  return match ? match[1] : null;
}

/**
 * Compares two dotted version strings numerically, so "3.10" is correctly
 * newer than "3.9" — which a string comparison gets backwards.
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(a, b) {
  const left = String(a ?? "").split(".");
  const right = String(b ?? "").split(".");

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = Number.parseInt(left[i] ?? "0", 10) || 0;
    const y = Number.parseInt(right[i] ?? "0", 10) || 0;
    if (x !== y) return x - y;
  }

  return 0;
}

/**
 * True when this user agent reports an SEB older than `minimum`.
 *
 * A user agent with no version in it is never called outdated: absence of
 * evidence is not evidence of an old copy, and refusing on it would lock out
 * anyone whose SEB simply words its user agent differently.
 */
export function isOutdated(userAgent, minimum) {
  if (!minimum) return false;

  const found = sebVersion(userAgent);
  return found !== null && compareVersions(found, minimum) < 0;
}

/** True when this copy is older than the newest release we know of. */
export function isBehindLatest(userAgent) {
  return isOutdated(userAgent, LATEST_SEB);
}

/**
 * What to tell someone whose copy is too old, in words a student can act on.
 * @param {string|null} found
 * @param {string} required
 */
export function updateMessage(found, required) {
  return (
    `This computer is running Safe Exam Browser ${found ?? "(unknown version)"}, ` +
    `but this test needs ${required} or newer. Download the current version from ` +
    "safeexambrowser.org, install it, then start the test again from the portal."
  );
}
