import { supabase, uploadAvatar, DEFAULT_AVATAR } from "../lib/supabase.js";
import { requireUser } from "../lib/session.js";
import { changePasswordSection } from "../lib/password.js";
import { errorMessage, setBusy, toast } from "../lib/ui.js";

const avatarPreview = document.getElementById("avatarPreview");
const nameInput = document.getElementById("nameInput");
const fileInput = document.getElementById("fileInput");
const saveBtn = document.getElementById("saveBtn");
const backBtn = document.getElementById("backBtn");

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const user = await requireUser();

avatarPreview.src = user.user_metadata?.photo || DEFAULT_AVATAR;
nameInput.value = user.user_metadata?.name || "";

document.getElementById("passwordMount")?.append(changePasswordSection());

let previewUrl = null;

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  if (file.size > MAX_AVATAR_BYTES) {
    toast("Please choose an image smaller than 2 MB.", "error");
    fileInput.value = "";
    return;
  }

  // Release the previous blob URL so repeated picks do not leak memory.
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  avatarPreview.src = previewUrl;
});

saveBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) {
    toast("Please enter your name.", "error");
    return;
  }

  const reset = setBusy(saveBtn, "Saving...");

  try {
    let photo = user.user_metadata?.photo || null;
    if (fileInput.files[0]) {
      photo = await uploadAvatar(fileInput.files[0], user.id);
    }

    const { error } = await supabase.auth.updateUser({ data: { name, photo } });
    if (error) throw error;

    toast("Profile updated.", "success");
    setTimeout(() => location.replace("dashboard.html"), 900);
  } catch (err) {
    console.error("Profile update failed:", err);
    toast(errorMessage(err, "Could not save your profile."), "error");
    reset();
  }
});

backBtn.addEventListener("click", () => {
  location.href = "dashboard.html";
});

window.addEventListener("pagehide", () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});
