import { supabase } from "../lib/supabase.js";
import { getRole } from "../lib/session.js";
import { sendResetEmail } from "../lib/password.js";
import { errorMessage, onSubmit, setBusy, toast } from "../lib/ui.js";

const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const loader = document.getElementById("loader");
const errorEl = document.getElementById("loginError");
const forgotBtn = document.getElementById("forgotBtn");

let inFlight = false;

/**
 * Where to go after signing in, when the user was sent here from a guarded
 * page. Only same-directory page names are accepted — an open redirect would
 * let someone mail out a portal link that lands on their own site.
 */
function safeNext() {
  const next = new URLSearchParams(location.search).get("next");
  if (!next) return null;
  return /^[\w.-]+\.html(\?[\w=%&.-]*)?$/.test(next) ? next : null;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

async function login() {
  if (inFlight) return;

  const email = emailEl.value.trim();
  const password = passwordEl.value;

  if (!email || !password) {
    showError("Enter your email and password.");
    return;
  }

  inFlight = true;
  showError("");
  const reset = setBusy(loginBtn, "Logging in...");

  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const role = await getRole(email);

    loader?.classList.remove("hidden");
    location.replace(safeNext() ?? (role === "admin" ? "admin.html" : "dashboard.html"));
  } catch (err) {
    console.error("Login failed:", err);
    showError(errorMessage(err, "Could not sign you in. Check your details and try again."));
    reset();
    inFlight = false;
  }
}

async function forgotPassword() {
  const email = emailEl.value.trim();

  if (!email) {
    showError("Enter your email address above, then choose Forgot password.");
    emailEl.focus();
    return;
  }

  showError("");
  const reset = setBusy(forgotBtn, "Sending...");

  try {
    await sendResetEmail(email);
    // Deliberately unconditional: confirming which addresses exist would leak
    // who has an account here.
    toast(`If an account exists for ${email}, a reset link is on its way.`, "success");
  } catch (err) {
    console.error("Reset email failed:", err);
    showError(errorMessage(err, "Could not send the reset email. Try again shortly."));
  } finally {
    reset();
  }
}

loginBtn?.addEventListener("click", login);
forgotBtn?.addEventListener("click", forgotPassword);
onSubmit([emailEl, passwordEl], login);
