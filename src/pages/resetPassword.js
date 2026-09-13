import { supabase } from "../lib/supabase.js";
import { updatePassword, validateNewPassword } from "../lib/password.js";
import { errorMessage, onSubmit, setBusy, toast } from "../lib/ui.js";

const intro = document.getElementById("resetIntro");
const form = document.getElementById("resetForm");
const errorEl = document.getElementById("resetError");
const newPassword = document.getElementById("newPassword");
const confirmPassword = document.getElementById("confirmPassword");
const saveBtn = document.getElementById("saveBtn");

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

/**
 * Supabase turns the emailed link into a recovery session. Depending on the
 * project's settings that arrives either as a code to exchange (PKCE) or as
 * tokens already in the URL fragment, so handle both before giving up.
 */
async function establishRecoverySession() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  const linkError = query.get("error_description") || hash.get("error_description");
  if (linkError) throw new Error(linkError);

  const code = query.get("code");
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return true;
  }

  // detectSessionInUrl consumes fragment tokens on load; give it a moment.
  const { data } = await supabase.auth.getSession();
  return Boolean(data.session);
}

async function save() {
  const problem = validateNewPassword(newPassword.value, confirmPassword.value);
  if (problem) {
    showError(problem);
    return;
  }

  showError("");
  const reset = setBusy(saveBtn, "Saving...");

  try {
    await updatePassword(newPassword.value);
    toast("Password updated. Redirecting to login...", "success");

    // Force a fresh sign-in with the new password.
    await supabase.auth.signOut();
    setTimeout(() => location.replace("index.html"), 1400);
  } catch (err) {
    console.error("Password reset failed:", err);
    showError(errorMessage(err, "Could not set your new password."));
    reset();
  }
}

try {
  const ready = await establishRecoverySession();

  if (ready) {
    intro.textContent = "Choose a new password for your account.";
    form.hidden = false;
    newPassword.focus();
  } else {
    intro.textContent = "This reset link is no longer valid.";
    showError("Reset links expire after a short time. Request a new one from the login page.");
  }
} catch (err) {
  console.error("Recovery link error:", err);
  intro.textContent = "This reset link is no longer valid.";
  showError(errorMessage(err, "Request a new reset link from the login page."));
}

saveBtn.addEventListener("click", save);
onSubmit([newPassword, confirmPassword], save);
