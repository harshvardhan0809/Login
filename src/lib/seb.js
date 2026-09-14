/**
 * Safe Exam Browser integration.
 *
 * Four jobs:
 *   1. Tell whether the page is being viewed inside SEB.
 *   2. Build the seb:// launch link that starts SEB with a given config.
 *   3. Generate the .seb configuration file itself.
 *   4. Give the exam page the URL that makes SEB quit.
 *
 * Read this before trusting any of it: detection here is client-side, based on
 * the user agent, which a student can spoof in thirty seconds. It is a
 * usability feature — it stops honest students opening the exam in the wrong
 * browser. Real enforcement requires the exam server to verify the
 * X-SafeExamBrowser-RequestHash header. See README "Enforcing SEB".
 */

/** Where a built-in test is taken. */
export function examPageUrl(testId) {
  return new URL(`exam.html?test=${encodeURIComponent(testId)}`, window.location.href).href;
}

/**
 * The address that ends the session.
 *
 * SEB watches for this URL and quits the moment the browser navigates to it,
 * without asking for the quit password. That is what lets the exam page close
 * SEB by itself a few seconds after a student submits. Nothing is ever served
 * here — SEB intercepts the navigation before it leaves the machine.
 */
export function sebQuitUrl(origin = window.location.origin) {
  return `${origin}/exam-complete`;
}

/** Storage bucket holding generated .seb files (see migration 0006). */
export const SEB_BUCKET = "seb-configs";

/** SEB identifies itself in the user agent on every platform. */
export function isRunningInSeb() {
  const ua = navigator.userAgent ?? "";
  return /\bSEB[\s/]/i.test(ua) || /SafeExamBrowser/i.test(ua);
}

/**
 * Converts the address of a hosted .seb file into a launch link.
 * SEB registers two schemes: seb:// for http and sebs:// for https.
 */
export function sebLaunchUrl(configUrl) {
  const url = (configUrl ?? "").trim();
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol === "https:")
    return `sebs://${parsed.host}${parsed.pathname}${parsed.search}`;
  if (parsed.protocol === "http:") return `seb://${parsed.host}${parsed.pathname}${parsed.search}`;

  // Already a seb:// link, or something we should not launch.
  return /^sebs?:$/.test(parsed.protocol) ? url : null;
}

const escapeXml = value =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** SEB stores passwords as an uppercase hex SHA-256 hash. */
export async function hashQuitPassword(password) {
  const bytes = new TextEncoder().encode(password ?? "");
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * A quit password a teacher can read out over the noise of an exam hall.
 *
 * No look-alike characters (0/O, 1/l/I) and no vowels, so it cannot spell
 * anything unfortunate, and grouped in fours so it can be dictated.
 *
 * Twelve characters rather than eight, because the .seb file is served from a
 * PUBLIC bucket — it has to be, since SEB fetches it before anyone signs in —
 * and it carries the unsalted SHA-256 of this password. Eight characters of
 * this alphabet is about 4x10^11 combinations, which a GPU chews through in
 * under a minute. Twelve is ~2x10^17, which is not worth anyone's afternoon.
 */
export function generateQuitPassword() {
  const alphabet = "23456789BCDFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const letters = [...bytes].map(byte => alphabet[byte % alphabet.length]);

  return [letters.slice(0, 4), letters.slice(4, 8), letters.slice(8)]
    .map(group => group.join(""))
    .join("-");
}

// --- property-list serialisation -------------------------------------------

/** Serialises one plist value. Numbers are always integers in SEB settings. */
function plistValue(value, indent) {
  const pad = " ".repeat(indent);

  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") return `<integer>${Math.trunc(value)}</integer>`;
  if (Array.isArray(value)) {
    if (!value.length) return "<array/>";
    const items = value.map(item => `${pad}  ${plistValue(item, indent + 2)}`);
    return `<array>\n${items.join("\n")}\n${pad}</array>`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, item]) => `${pad}  <key>${escapeXml(key)}</key>${plistValue(item, indent + 2)}`
    );
    return `<dict>\n${entries.join("\n")}\n${pad}</dict>`;
  }
  return `<string>${escapeXml(value ?? "")}</string>`;
}

/** One URL filter rule. action 1 = allow. */
function allowRule(expression) {
  return { action: 1, active: true, expression, regex: false };
}

/**
 * Applications a student must not be able to run alongside the exam.
 *
 * os: 0 = macOS, 1 = Windows. strongKill lets SEB terminate one that is
 * already running rather than simply refusing to start.
 */
const PROHIBITED_PROCESSES = [
  ["obs", "OBS Studio", 1],
  ["obs64", "OBS Studio", 1],
  ["OBS", "OBS Studio", 0],
  ["TeamViewer", "TeamViewer", 1],
  ["TeamViewer", "TeamViewer", 0],
  ["AnyDesk", "AnyDesk", 1],
  ["AnyDesk", "AnyDesk", 0],
  ["Zoom", "Zoom", 0],
  ["Zoom", "Zoom", 1],
  ["Discord", "Discord", 1],
  ["Discord", "Discord", 0],
  ["vncserver", "VNC server", 1],
  ["RemoteDesktopManager", "Remote desktop", 1],
  ["Camtasia", "Camtasia", 1],
  ["SnagitEditor", "Snagit", 1],
  ["chrome_remote_desktop", "Chrome Remote Desktop", 1],
].map(([executable, description, os]) => ({
  active: true,
  currentUser: true,
  strongKill: true,
  os,
  executable,
  description,
  identifier: "",
}));

/** Function keys are disabled as a block: F5 reloads, F11 leaves fullscreen. */
const FUNCTION_KEYS = Object.fromEntries(
  Array.from({ length: 12 }, (_, index) => [`enableF${index + 1}`, false])
);

/**
 * The lockdown itself — the settings a real exam deployment turns on.
 *
 * Grouped by what each group prevents rather than by platform, because most
 * of these have a macOS key and a Windows key doing the same job.
 */
const EXAM_LOCKDOWN = {
  // Full-screen kiosk window with no address bar to type a new URL into.
  browserViewMode: 1,
  mainBrowserWindowWidth: "100%",
  mainBrowserWindowHeight: "100%",
  enableBrowserWindowToolbar: false,
  hideBrowserWindowToolbar: true,
  showMenuBar: false,
  showTaskBar: true,
  taskBarHeight: 40,
  showTime: true,
  showInputLanguage: false,
  touchOptimized: false,

  // No way to navigate off the exam, open a second window, or reload past it.
  allowBrowsingBackForward: false,
  showNavigationButtons: false,
  showReloadButton: false,
  newBrowserWindowByLinkPolicy: 0,
  newBrowserWindowByScriptPolicy: 0,
  blockPopUpWindows: true,
  allowDownUploads: false,
  allowDownloads: false,
  downloadPDFFiles: false,
  allowPDFReaderToolbar: false,

  // No other application, desktop, or user account during the exam.
  allowSwitchToApplications: false,
  allowUserSwitching: false,
  enableAppSwitcherCheck: true,
  forceAppFolderInstall: true,
  detectStoppedProcess: true,
  monitorProcesses: true,
  createNewDesktop: true,
  killExplorerShell: false,
  allowVirtualMachine: false,
  allowScreenSharing: false,
  allowDisplayMirroring: false,
  allowedDisplaysMaxNumber: 1,
  allowSiri: false,
  allowDictation: false,
  allowWlan: false,

  // No dictionary, spell check or clipboard to smuggle answers through.
  allowSpellCheck: false,
  allowDictionaryLookup: false,
  allowDictationInput: false,
  enablePrivateClipboard: true,
  allowAudioCapture: false,
  allowVideoCapture: false,
  audioControlEnabled: false,

  // Shortcuts that would otherwise escape the exam window.
  enableAltEsc: false,
  enableAltTab: false,
  enableAltF4: false,
  enableCtrlEsc: false,
  enableEsc: false,
  enableRightMouse: false,
  enablePrintScreen: false,
  enableZoomText: false,
  enableZoomPage: false,
  ...FUNCTION_KEYS,

  // The page itself needs scripts; plugins and Java are attack surface.
  enableJavaScript: true,
  enablePlugIns: false,
  enableJava: false,

  // A fresh session every time, and nothing left behind afterwards.
  examSessionClearCookiesOnStart: true,
  examSessionClearCookiesOnEnd: true,
  removeBrowserProfile: true,

  // Settings cannot be changed from inside a running exam.
  allowReconfiguration: false,
  allowPreferencesWindow: false,
  restartExamPasswordProtected: true,

  // Let the exam server verify that these settings are the ones in force.
  sendBrowserExamKey: true,

  // Only the addresses listed below may load, in the page and in its frames.
  URLFilterEnable: true,
  URLFilterEnableContentFilter: true,
  blacklistURLFilter: "",

  // 1 = use the SEB Windows service when it is installed. 2 would refuse to
  // start without it, which locks out students on machines they do not
  // administer; that is a decision for a school, not a default.
  sebServicePolicy: 1,
};

/**
 * Builds an unencrypted .seb configuration file (an XML property list).
 *
 * Unencrypted is deliberate: it can be inspected and diffed, and SEB opens it
 * fine. Add a settings password in SEB Config Tool if you need it sealed.
 *
 * @param {object} options
 * @param {string} options.startUrl        Page SEB opens (the exam itself).
 * @param {string[]} options.allowedUrls   Expressions students may reach.
 * @param {string} [options.quitUrl]       Navigating here quits SEB.
 * @param {string} [options.hashedQuitPassword] From hashQuitPassword().
 * @param {boolean} [options.allowReload]  Reload is off during an exam.
 */
export function buildSebConfig({
  startUrl,
  allowedUrls = [],
  quitUrl = "",
  hashedQuitPassword = "",
  allowReload = false,
}) {
  if (!startUrl) throw new Error("A .seb config needs a start URL.");

  // The start URL must itself be reachable, so it is always whitelisted.
  const expressions = [...new Set([`${startUrl}*`, ...allowedUrls.filter(Boolean)])];

  const settings = {
    originatorVersion: "Exam Portal",
    startURL: startUrl,
    ...EXAM_LOCKDOWN,
    browserWindowAllowReload: allowReload,
    browserWindowAllowReloadInExam: allowReload,

    // Quitting: the button asks for the password, so a student cannot simply
    // walk out mid-exam. Reaching quitURL — which only happens after the exam
    // page has submitted — quits with no prompt at all.
    allowQuit: true,
    hashedQuitPassword,
    quitURL: quitUrl,
    quitURLConfirm: false,

    URLFilterRules: expressions.map(allowRule),
    prohibitedProcesses: PROHIBITED_PROCESSES,
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(settings, 0)}
</plist>
`;
}

/** Filename for a test's config, safe on every OS. */
export function sebConfigFilename(title) {
  const slug = String(title ?? "exam")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

  return `${slug || "exam"}.seb`;
}

/**
 * Everything a test's config must let through.
 *
 * Getting this list wrong is the failure mode that looks like a broken login:
 * SEB blocks the API request, the exam page cannot see the session, and it
 * bounces the student to a login page that then also fails.
 */
function allowedUrlsForTest(test, origin, apiOrigin) {
  const allowed = [`${origin}/*`, `${apiOrigin}/*`];

  if (test.kind !== "link") return allowed;

  // A Google Form pulls in accounts, fonts and static assets from several
  // Google hosts; whitelisting only docs.google.com renders it unusable.
  try {
    allowed.push(`${new URL(test.form_url).origin}/*`);
  } catch {
    // An invalid link is caught before publishing; nothing to add here.
  }

  return allowed.concat([
    "https://docs.google.com/*",
    "https://accounts.google.com/*",
    "https://www.google.com/*",
    "https://*.googleusercontent.com/*",
    "https://*.gstatic.com/*",
    "https://fonts.googleapis.com/*",
  ]);
}

/**
 * Generates a test's .seb config, uploads it, and returns its public URL.
 *
 * Teachers should never touch a config file: this runs whenever a test is
 * published or its settings change.
 *
 * @param {object} supabase Client with admin rights for the current user.
 * @param {object} test Row from `tests` (needs id, kind, form_url).
 * @param {string} [quitPassword] Plain text; stored hashed in the config.
 * @returns {Promise<string>} Public URL of the stored config.
 */
export async function publishSebConfig(supabase, test, quitPassword = "") {
  const origin = window.location.origin;

  // The API host must be whitelisted too, or every auth and data request is
  // blocked and the exam page cannot load at all.
  const apiOrigin = new URL(import.meta.env.VITE_SUPABASE_URL).origin;

  // A link test opens the teacher's form; a built-in test opens this portal.
  const startUrl = test.kind === "link" ? test.form_url : examPageUrl(test.id);
  if (!startUrl) throw new Error("This test has no address for Safe Exam Browser to open.");

  const xml = buildSebConfig({
    startUrl,
    allowedUrls: allowedUrlsForTest(test, origin, apiOrigin),
    quitUrl: sebQuitUrl(origin),
    hashedQuitPassword: quitPassword ? await hashQuitPassword(quitPassword) : "",
  });

  const path = `${test.id}.seb`;
  const file = new Blob([xml], { type: "application/octet-stream" });

  const { error } = await supabase.storage.from(SEB_BUCKET).upload(path, file, {
    contentType: "application/octet-stream",
    // No caching: a refreshed config must take effect immediately, or SEB can
    // fetch a stale one and silently block the exam.
    cacheControl: "0",
    // Editing a test must replace its config, not fail on a name clash.
    upsert: true,
  });
  if (error) throw error;

  const { data } = supabase.storage.from(SEB_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/** Removes a test's config file. Failure is not fatal — the row matters more. */
export async function removeSebConfig(supabase, testId) {
  const { error } = await supabase.storage.from(SEB_BUCKET).remove([`${testId}.seb`]);
  if (error) console.error("Could not remove .seb config:", error.message);
}

/** True when the upload failed because migration 0006 has not been run. */
export function isMissingSebBucket(error) {
  return /bucket not found|does not exist/i.test(error?.message ?? "");
}
