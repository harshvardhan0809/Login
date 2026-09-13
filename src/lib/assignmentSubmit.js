/**
 * Handing in an assignment as a link.
 *
 * Deliberately inline rather than a modal: a student pasting a link wants to
 * see the assignment it belongs to and the link they submitted last time, and
 * a dialog hides both. The form opens inside the card it belongs to.
 */
import { supabase } from "./supabase.js";
import { el, errorMessage, setBusy, toast } from "./ui.js";
import { formatDateTime, isPastDue, relativeTime, submissionDeadline } from "./dates.js";
import { celebrate } from "./celebrate.js";

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** True when the table has not been created yet (migration 0010). */
export function isMissingSubmissions(error) {
  return error?.code === "PGRST205" || error?.code === "42P01" || error?.code === "42703";
}

/**
 * True when the database refused the write because the deadline has passed.
 *
 * The browser and the database work out the deadline in different timezones,
 * so they can disagree for a few hours either side of midnight. When they do,
 * the database wins — this turns its refusal into a sentence a student can
 * act on rather than "new row violates row-level security policy".
 */
function isClosedByServer(error) {
  return error?.code === "42501" || /row-level security/i.test(error?.message ?? "");
}

/**
 * Builds the hand-in area for one assignment.
 *
 * @param {object} assignment Row from `assignments`.
 * @param {object|null} submission This student's existing hand-in, if any.
 * @param {string} email The signed-in student's address.
 * @param {Function} onSaved Called after a successful submit, to reload.
 * @returns {HTMLElement}
 */
export function submissionBox(assignment, submission, email, onSaved) {
  const closed = isPastDue(assignment.due_date);
  const deadline = submissionDeadline(assignment.due_date);

  const box = el("div", { className: `submission-box${closed ? " submission-closed" : ""}` });

  const input = el("input", {
    type: "url",
    value: submission?.link_url ?? "",
    placeholder: "https://docs.google.com/document/d/...",
  });

  const noteInput = el("input", {
    type: "text",
    value: submission?.note ?? "",
    placeholder: "Anything your teacher should know (optional)",
  });

  const saveBtn = el("button", {
    type: "button",
    text: submission ? "Update submission" : "Submit",
  });
  const cancelBtn = el("button", { type: "button", className: "secondary", text: "Cancel" });

  const form = el("div", { className: "submission-form", hidden: true }, [
    el("div", { className: "field" }, [
      el("label", { text: "Link to your work" }),
      input,
      el("small", {
        className: "hint",
        // The single most common failure: the link works for the student,
        // who is signed in as its owner, and 404s for everyone else.
        text: "Set sharing to “Anyone with the link can view”, or your teacher will not be able to open it.",
      }),
    ]),
    el("div", { className: "field" }, [el("label", { text: "Note" }), noteInput]),
    el("div", { className: "submission-actions" }, [saveBtn, cancelBtn]),
  ]);

  // Stated as an exact moment, not "due Friday". A student deciding whether
  // they still have time needs the hour, and after this it cannot be changed.
  if (deadline) {
    form.append(
      el("small", {
        className: "hint",
        text: `You can change this until ${formatDateTime(deadline)}. After that it is locked.`,
      })
    );
  }

  function renderStatus() {
    const status = el("div", { className: "submission-status" });

    if (submission) {
      status.append(
        el("span", { className: "pill pill-live", text: "Submitted" }),
        el("a", {
          className: "submission-link",
          href: submission.link_url,
          target: "_blank",
          rel: "noreferrer",
          text: "Open your work",
        }),
        el("span", { className: "submission-when", text: relativeTime(submission.updated_at) })
      );
    } else {
      status.append(
        el("span", {
          className: "submission-when",
          text: closed ? "Not submitted" : "Not submitted yet",
        })
      );
    }

    // Past the deadline nothing can be written, so offering a button that the
    // database will refuse would be worse than offering none.
    if (closed) {
      status.append(
        el("span", {
          className: `pill ${submission ? "pill-draft" : "pill-closed"}`,
          text: "Closed",
        })
      );
      return status;
    }

    const openBtn = el("button", {
      type: "button",
      className: submission ? "edit-btn" : "start-btn",
      text: submission ? "Change link" : "Submit work",
    });

    openBtn.addEventListener("click", () => {
      form.hidden = false;
      status.hidden = true;
      input.focus();
    });

    cancelBtn.addEventListener("click", () => {
      form.hidden = true;
      status.hidden = false;
      input.value = submission?.link_url ?? "";
      noteInput.value = submission?.note ?? "";
    });

    status.append(openBtn);
    return status;
  }

  saveBtn.addEventListener("click", async () => {
    const link = input.value.trim();

    if (!isValidUrl(link)) {
      toast("Paste a full link starting with https://", "error");
      return;
    }

    const reset = setBusy(saveBtn, "Submitting...");

    // The row is keyed by (assignment, student), so one upsert covers both a
    // first hand-in and a replacement.
    //
    // The address is sent because it is half of the conflict target, not
    // because it is trusted: a BEFORE trigger overwrites it with the signed-in
    // identity, so a student editing this payload still cannot hand in as
    // somebody else.
    const { error } = await supabase.from("assignment_submissions").upsert(
      {
        assignment_id: assignment.id,
        email,
        link_url: link,
        note: noteInput.value.trim() || null,
      },
      { onConflict: "assignment_id,email" }
    );
    reset();

    if (error) {
      console.error("Submit assignment failed:", error.message);
      if (isClosedByServer(error)) {
        toast(
          "The deadline for this assignment has passed, so it can no longer be changed.",
          "error"
        );
        await onSaved();
        return;
      }

      toast(
        isMissingSubmissions(error)
          ? "Run supabase/migrations/0010_assignment_submissions.sql to enable hand-ins."
          : errorMessage(error, "Could not submit your work."),
        "error"
      );
      return;
    }

    toast(submission ? "Submission updated." : "Work submitted.", "success");
    if (!submission) celebrate(box);
    await onSaved();
  });

  box.append(renderStatus(), form);
  return box;
}
