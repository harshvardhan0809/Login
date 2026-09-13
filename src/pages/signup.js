import { supabase, uploadAvatar } from "../lib/supabase.js";
import { errorMessage, onSubmit, setBusy, toast } from "../lib/ui.js";

const nameEl = document.getElementById("name");
const emailEl = document.getElementById("email");
const mobileEl = document.getElementById("mobile");
const passwordEl = document.getElementById("password");
const avatarEl = document.getElementById("avatar");
const signupBtn = document.getElementById("signupBtn");
const fileNameEl = document.getElementById("fileName");

const MIN_PASSWORD_LENGTH = 6;

avatarEl?.addEventListener("change", () => {
  fileNameEl.textContent = avatarEl.files[0]?.name || "";
});

function validate() {
  if (!nameEl.value.trim()) return "Please enter your full name.";
  if (!emailEl.value.trim()) return "Please enter your email address.";
  if (passwordEl.value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

async function signUp() {
  const problem = validate();
  if (problem) {
    toast(problem, "error");
    return;
  }

  const reset = setBusy(signupBtn, "Creating account...");

  try {
    const { data, error } = await supabase.auth.signUp({
      email: emailEl.value.trim(),
      password: passwordEl.value,
      options: {
        data: {
          name: nameEl.value.trim(),
          mobile: mobileEl.value.trim() || null,
        },
      },
    });
    if (error) throw error;

    const user = data.user;

    if (user) {
      // No role row is written here on purpose. The `on_auth_user_created`
      // trigger creates it as a student, so the browser never gets to pick its
      // own role. See supabase/migrations/0001_harden_security.sql.

      // A failed avatar upload must not fail the whole signup.
      const file = avatarEl.files[0];
      if (file) {
        try {
          const photo = await uploadAvatar(file, user.id);
          await supabase.auth.updateUser({ data: { photo } });
        } catch (uploadError) {
          console.error("Avatar upload failed:", uploadError);
          toast("Account created, but the profile picture could not be uploaded.", "info");
        }
      }
    }

    toast("Account created. Redirecting to login...", "success");
    setTimeout(() => location.replace("index.html"), 1200);
  } catch (err) {
    console.error("Signup failed:", err);
    toast(errorMessage(err, "Could not create the account."), "error");
    reset();
  }
}

signupBtn?.addEventListener("click", signUp);
onSubmit([nameEl, emailEl, mobileEl, passwordEl], signUp);
