/**
 * Password recovery and change, shared by the login page, the reset page, and
 * the change-password panels on the dashboard and admin portal.
 */
import { supabase } from "./supabase.js";
import { el, errorMessage, setBusy, toast } from "./ui.js";

export const MIN_PASSWORD_LENGTH = 6;

/** Where Supabase should send the user after they click the emailed link. */
function resetRedirectUrl() {
  return new URL("reset-password.html", window.location.href).href;
}

/**
 * Emails a recovery link. Always reports success: telling a stranger whether
 * an address has an account here would leak who your students are.
 */
export async function sendResetEmail(email) {
  const address = (email ?? "").trim();
  if (!address) throw new Error("Enter your email address first.");

  const { error } = await supabase.auth.resetPasswordForEmail(address, {
    redirectTo: resetRedirectUrl(),
  });

  // Rate limiting is worth surfacing; a missing account is not.
  if (error && /rate|too many|seconds/i.test(error.message)) throw error;
  if (error) console.error("Reset email error:", error.message);
}

/** Validates a new password and its confirmation. Returns an error string. */
export function validateNewPassword(password, confirmation) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirmation) return "The two passwords do not match.";
  return null;
}

/** Applies a new password to the signed-in (or recovering) user. */
export async function updatePassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

/**
 * Builds the "Change password" panel used on the dashboard and admin portal.
 * Both pages get the same markup and behaviour from one place.
 */
export function changePasswordSection() {
  const next = el("input", {
    id: "newPassword",
    type: "password",
    autocomplete: "new-password",
    placeholder: `At least ${MIN_PASSWORD_LENGTH} characters`,
  });
  const confirm = el("input", {
    id: "confirmPassword",
    type: "password",
    autocomplete: "new-password",
    placeholder: "Repeat the new password",
  });
  const saveBtn = el("button", {
    type: "button",
    className: "secondary block",
    text: "Update Password",
  });

  saveBtn.addEventListener("click", async () => {
    const problem = validateNewPassword(next.value, confirm.value);
    if (problem) {
      toast(problem, "error");
      return;
    }

    const reset = setBusy(saveBtn, "Updating...");
    try {
      await updatePassword(next.value);
      next.value = "";
      confirm.value = "";
      toast("Password updated.", "success");
    } catch (err) {
      console.error("Password update failed:", err);
      toast(errorMessage(err, "Could not update your password."), "error");
    } finally {
      reset();
    }
  });

  const field = (id, label, input) =>
    el("div", { className: "field" }, [el("label", { htmlFor: id, text: label }), input]);

  return el("section", { className: "section" }, [
    el("div", { className: "section-title" }, [
      el("h2", { text: "Change Password" }),
      el("span", { text: "Applies to this account" }),
    ]),
    el("div", { className: "password-panel" }, [
      el("div", { className: "form-stack" }, [
        field("newPassword", "New password", next),
        field("confirmPassword", "Confirm new password", confirm),
      ]),
      saveBtn,
    ]),
  ]);
}
