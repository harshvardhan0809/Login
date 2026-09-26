import { supabase, isMissingTable, setupHint } from "../lib/supabase.js";
import { requireAdmin, wireLogout } from "../lib/session.js";
import { describeVideo } from "../lib/video.js";
import {
  dueStatus,
  formatDateTime,
  formatDuration,
  fromDatetimeLocal,
  isPastDue,
  relativeTime,
  submissionDeadline,
  testWindow,
  toDatetimeLocal,
} from "../lib/dates.js";
import {
  generateQuitPassword,
  isMissingSebBucket,
  publishSebConfig,
  removeSebConfig,
} from "../lib/seb.js";
import { openSebGate } from "../lib/sebGate.js";
import { openQuestionEditor } from "../lib/questionEditor.js";
import { penaltyLabel } from "../lib/marking.js";
import { LATEST_SEB } from "../lib/sebVersion.js";
import { isMissingAudience, openAudienceEditor } from "../lib/audienceEditor.js";
import { changePasswordSection } from "../lib/password.js";
import { noticeCard, sortNotices } from "../lib/noticeBoard.js";
import { isMissingSubmissions } from "../lib/assignmentSubmit.js";
import { sebBadge } from "../lib/sebBadge.js";
import {
  countLabel,
  el,
  errorMessage,
  renderList,
  setBusy,
  setNotice,
  toast,
  wireTabs,
} from "../lib/ui.js";

const addTestBtn = document.getElementById("addTestBtn");
const testTitle = document.getElementById("testTitle");
const testSubject = document.getElementById("testSubject");
const testRequiresSeb = document.getElementById("testRequiresSeb");
const testKind = document.getElementById("testKind");
const testLink = document.getElementById("testLink");
const testLinkField = document.getElementById("testLinkField");
const testShuffleFields = document.getElementById("testShuffleFields");
const testNegative = document.getElementById("testNegative");
const testShuffleQuestions = document.getElementById("testShuffleQuestions");
const testShuffleOptions = document.getElementById("testShuffleOptions");
const testDuration = document.getElementById("testDuration");
const testCloses = document.getElementById("testCloses");
const testOpens = document.getElementById("testOpens");
const adminTestsList = document.getElementById("adminTestsList");
const questionEditor = document.getElementById("questionEditor");
const adminResultsList = document.getElementById("adminResultsList");
const adminTestsCount = document.getElementById("adminTestsCount");
const adminResultsCount = document.getElementById("adminResultsCount");
const addNoticeBtn = document.getElementById("addNoticeBtn");
const noticeTitle = document.getElementById("noticeTitle");
const noticeBody = document.getElementById("noticeBody");
const noticePinned = document.getElementById("noticePinned");
const noticeCategory = document.getElementById("noticeCategory");
const noticePriority = document.getElementById("noticePriority");
const adminNoticesList = document.getElementById("adminNoticesList");
const adminNoticesCount = document.getElementById("adminNoticesCount");
const addAssignmentBtn = document.getElementById("addAssignmentBtn");
const assignmentTitle = document.getElementById("assignmentTitle");
const assignmentSubject = document.getElementById("assignmentSubject");
const assignmentDescription = document.getElementById("assignmentDescription");
const assignmentDue = document.getElementById("assignmentDue");
const assignmentLink = document.getElementById("assignmentLink");
const assignmentAccepts = document.getElementById("assignmentAcceptsSubmissions");
const adminAssignmentsList = document.getElementById("adminAssignmentsList");
const adminAssignmentsCount = document.getElementById("adminAssignmentsCount");
const addVideoBtn = document.getElementById("addVideoBtn");
const videoTitle = document.getElementById("videoTitle");
const videoSubject = document.getElementById("videoSubject");
const videoDescription = document.getElementById("videoDescription");
const videoLink = document.getElementById("videoLink");
const adminVideosList = document.getElementById("adminVideosList");
const adminVideosCount = document.getElementById("adminVideosCount");
const totalVideos = document.getElementById("totalVideos");
const totalTests = document.getElementById("totalTests");
const totalAttempts = document.getElementById("totalAttempts");
const avgScore = document.getElementById("avgScore");

await requireAdmin();
wireLogout();
wireTabs(document.querySelector('[role="tablist"]'));
document.getElementById("passwordMount")?.append(changePasswordSection());

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Labels a field with an optional hint, for the inline settings editor. */
function labelled(text, control, hint) {
  const children = [el("label", { text }), control];
  if (hint) children.push(el("small", { className: "hint", text: hint }));
  return el("div", { className: "field" }, children);
}

/** A link test has nowhere to put questions, so the link box replaces them. */
function syncKindFields() {
  testLinkField.hidden = testKind.value !== "link";
  testShuffleFields.hidden = testKind.value === "link";
}

testKind.addEventListener("change", syncKindFields);
syncKindFields();

/**
 * Validates the time limit and deadline shared by the create and edit forms.
 *
 * @param {string|null} [current] The deadline already stored on this test.
 *   A test whose deadline has passed must stay editable — otherwise fixing a
 *   typo in its title would be blocked by a date the teacher did not touch.
 * @returns {{duration_minutes: number|null, closes_at: string|null}|null}
 */
function readSchedule(durationInput, opensInput, closesInput, current = null) {
  const raw = durationInput.value.trim();
  let duration = null;

  if (raw) {
    duration = Number(raw);
    if (!Number.isInteger(duration) || duration < 1 || duration > 600) {
      toast("Maximum time must be a whole number of minutes, from 1 to 600.", "error");
      return null;
    }
  }

  const opensAt = fromDatetimeLocal(opensInput.value);
  const closesAt = fromDatetimeLocal(closesInput.value);
  const unchanged = closesAt === current || toDatetimeLocal(current) === closesInput.value;

  // A newly set deadline in the past would hide the test the moment it is
  // published. Unpublish is the way to close a test early.
  if (closesAt && !unchanged && new Date(closesAt) <= new Date()) {
    toast("That deadline has already passed. Pick a later one.", "error");
    return null;
  }

  // The database rejects this too, but a constraint violation is a poor way to
  // learn you typed the dates the wrong way round.
  if (opensAt && closesAt && new Date(opensAt) >= new Date(closesAt)) {
    toast("The start time must come before the deadline.", "error");
    return null;
  }

  return { duration_minutes: duration, opens_at: opensAt, closes_at: closesAt };
}

function readTestForm() {
  const title = testTitle.value.trim();
  const subject = testSubject.value.trim();
  const kind = testKind.value;

  if (!title || !subject) {
    toast("A test needs a title and a subject.", "error");
    return null;
  }

  const link = testLink.value.trim();
  if (kind === "link" && !isValidUrl(link)) {
    toast("Paste the http(s) link to your Google Form.", "error");
    return null;
  }

  const schedule = readSchedule(testDuration, testOpens, testCloses);
  if (!schedule) return null;

  return {
    title,
    subject,
    kind,
    form_url: kind === "link" ? link : null,
    requires_seb: testRequiresSeb.checked,
    // Sent only when set, so creating tests still works before the migration
    // that adds each column has been run.
    ...(Number(testNegative.value) > 0 ? { negative_marking: Number(testNegative.value) } : {}),
    ...(kind === "builtin" && testShuffleQuestions.checked ? { shuffle_questions: true } : {}),
    ...(kind === "builtin" && testShuffleOptions.checked ? { shuffle_options: true } : {}),
    // Always a draft. Releasing is a separate, deliberate press, so questions
    // are finished before any student can open the test.
    status: "draft",
    ...schedule,
  };
}

addTestBtn.addEventListener("click", async () => {
  const payload = readTestForm();
  if (!payload) return;

  const reset = setBusy(addTestBtn, "Creating...");
  const { error } = await supabase.from("tests").insert([payload]);
  reset();

  if (error) {
    console.error("Create test failed:", error.message);
    toast(
      isMissingColumn(error)
        ? "Run the newest migrations in supabase/migrations/ (0021 adds SEB key checks)."
        : errorMessage(error, "Could not create the test."),
      "error"
    );
    return;
  }

  testTitle.value = "";
  testSubject.value = "";
  testLink.value = "";
  testDuration.value = "";
  testOpens.value = "";
  testCloses.value = "";
  testRequiresSeb.checked = true;
  testNegative.value = "0";
  testShuffleQuestions.checked = false;
  testShuffleOptions.checked = false;
  testKind.value = "builtin";
  syncKindFields();

  toast(
    payload.kind === "link"
      ? "Draft created. Check the link, then publish it."
      : "Draft created. Add its questions, then publish it.",
    "success"
  );

  await Promise.all([loadTests(), loadStats()]);
});

/** Migration 0008 has not been run, so the new columns are missing. */
function isMissingColumn(error) {
  return (
    error?.code === "42703" ||
    error?.code === "PGRST204" ||
    /column .* does not exist|could not find the .* column/i.test(error?.message ?? "")
  );
}

/**
 * Regenerates and re-hosts a test's lockdown config.
 *
 * Also mints a quit password on first use and keeps it in test_secrets, which
 * only admins can read — a student holding it could leave mid-exam.
 */
async function refreshLockdown(test) {
  const quitPassword = quitPasswords.get(test.id) ?? generateQuitPassword();
  const configUrl = await publishSebConfig(supabase, test, quitPassword);

  const { error: secretError } = await supabase.from("test_secrets").upsert({
    test_id: test.id,
    quit_password: quitPassword,
    updated_at: new Date().toISOString(),
  });

  if (secretError) {
    throw isMissingTable(secretError)
      ? new Error("Run supabase/migrations/0008_exam_delivery.sql to store quit passwords.")
      : secretError;
  }

  const { error } = await supabase
    .from("tests")
    .update({ seb_config_url: configUrl })
    .eq("id", test.id);
  if (error) throw error;

  quitPasswords.set(test.id, quitPassword);
  return configUrl;
}

/** Why this test is not ready to release yet, or null when it is. */
function publishBlocker(test) {
  if (test.kind === "link") {
    return isValidUrl(test.form_url ?? "")
      ? null
      : "Add the link to the test before publishing it.";
  }
  return questionCounts.get(test.id)
    ? null
    : "Add at least one question before publishing this test.";
}

async function setStatus(test, status, button) {
  const blocker = status === "published" ? publishBlocker(test) : null;
  if (blocker) {
    toast(blocker, "error");
    return;
  }

  const reset = setBusy(button, status === "published" ? "Publishing..." : "Unpublishing...");

  try {
    // The config is built here rather than at creation time because it depends
    // on settings a teacher is still editing while the test is a draft.
    if (status === "published" && test.requires_seb !== false) {
      await refreshLockdown(test);
    }

    const { error } = await supabase
      .from("tests")
      .update({
        status,
        published_at: status === "published" ? new Date().toISOString() : null,
      })
      .eq("id", test.id);
    if (error) throw error;

    toast(
      status === "published"
        ? "Published. Students can see it now."
        : "Unpublished. Students can no longer open it.",
      "success"
    );
    await loadTests();
  } catch (err) {
    console.error("Publish failed:", err);
    toast(
      isMissingSebBucket(err)
        ? "Run supabase/migrations/0006_seb_config_storage.sql first."
        : errorMessage(err, "Could not change the test's status."),
      "error"
    );
  } finally {
    reset();
  }
}

/** Swaps a test card into an inline settings form. */
function editForm(test, onDone) {
  // Empty until a teacher has opened the test in SEB, or pasted a key.
  const lock = lockdowns.get(test.id) ?? {};
  const titleInput = el("input", { value: test.title, placeholder: "Title" });
  const subjectInput = el("input", { value: test.subject, placeholder: "Subject" });
  const linkInput = el("input", {
    type: "url",
    value: test.form_url ?? "",
    placeholder: "https://docs.google.com/forms/...",
  });
  const durationInput = el("input", {
    type: "number",
    min: "1",
    max: "600",
    value: test.duration_minutes ?? "",
    placeholder: "No limit",
  });
  const opensInput = el("input", {
    type: "datetime-local",
    value: toDatetimeLocal(test.opens_at),
  });
  const closesInput = el("input", {
    type: "datetime-local",
    value: toDatetimeLocal(test.closes_at),
  });
  const sebInput = el("input", { type: "checkbox", checked: test.requires_seb !== false });
  const bekInput = el("input", {
    type: "text",
    value: lock.seb_browser_exam_key ?? "",
    placeholder: "64 characters, copied from Safe Exam Browser",
    spellcheck: false,
    autocapitalize: "off",
  });
  const enforcementSelect = el("select", {}, [
    el("option", { value: "auto", text: "Automatic — recognise the SEB you open it in" }),
    el("option", { value: "watch", text: "Off — record only, never refuse anyone" }),
    el("option", { value: "strict", text: "Strict — require the key pasted below" }),
  ]);
  enforcementSelect.value = ["watch", "strict"].includes(test.seb_enforcement)
    ? test.seb_enforcement
    : "auto";

  const learnedAt = lock.seb_fingerprint_at;
  const learnedNote = el("p", {
    className: `hint ${lock.seb_fingerprint ? "is-ok" : ""}`,
    text: lock.seb_fingerprint
      ? `Recognising your Safe Exam Browser since ${formatDateTime(learnedAt)}. Students must match it.`
      : "Not set up yet — open this test once in Safe Exam Browser and it configures itself.",
  });

  // The key is the manual fallback, so it is folded away: nothing here needs
  // filling in for the automatic check to work.
  const advanced = el("details", { className: "seb-advanced" }, [
    el("summary", { text: "Pin to one copy of SEB (optional)" }),
    labelled(
      "Browser Exam Key",
      bekInput,
      "Only needed for Strict. In Safe Exam Browser: Preferences → Exam → Browser Exam Key."
    ),
  ]);

  // Hidden unless the test is locked down at all, so a test without SEB does
  // not show settings that can do nothing.
  const minVersionInput = el("input", {
    type: "text",
    value: test.seb_min_version ?? "",
    placeholder: `e.g. ${LATEST_SEB} — leave blank to allow any version`,
    spellcheck: false,
  });

  const sebFields = el("div", { className: "form-stack seb-fields" }, [
    labelled("Verification", enforcementSelect, "Automatic needs nothing typed in."),
    labelled(
      "Minimum SEB version",
      minVersionInput,
      `An older Safe Exam Browser is the usual reason verification fails. A machine below ` +
        `this is told to update, naming the version it has. The current release is ${LATEST_SEB}.`
    ),
    learnedNote,
    advanced,
  ]);
  const syncSeb = () => {
    sebFields.hidden = !sebInput.checked;
  };
  sebInput.addEventListener("change", syncSeb);
  syncSeb();

  const negativeSelect = el(
    "select",
    {},
    [
      ["0", "None — a wrong answer costs nothing"],
      ["0.25", "¼ of the marks (+4 → −1)"],
      ["0.3333", "⅓ of the marks (+3 → −1)"],
      ["0.5", "½ of the marks (+4 → −2)"],
    ].map(([value, label]) => el("option", { value, text: label }))
  );
  negativeSelect.value = String(test.negative_marking ?? 0);
  // A value set directly in the database stays selectable rather than being
  // silently reset to None by this form.
  if (negativeSelect.selectedIndex === -1) {
    negativeSelect.append(
      el("option", {
        value: String(test.negative_marking),
        text: `${test.negative_marking} of the marks`,
      })
    );
    negativeSelect.value = String(test.negative_marking);
  }
  const shuffleQInput = el("input", { type: "checkbox", checked: test.shuffle_questions === true });
  const shuffleOptInput = el("input", { type: "checkbox", checked: test.shuffle_options === true });
  const shuffleFields = el("div", {}, [
    el("label", { className: "checkbox-field" }, [
      shuffleQInput,
      el("span", { text: "Shuffle question order for each student" }),
    ]),
    el("label", { className: "checkbox-field" }, [
      shuffleOptInput,
      el("span", { text: "Shuffle answer options for each student" }),
    ]),
  ]);

  const kindSelect = el("select", {}, [
    el("option", { value: "builtin", text: "Write them here (auto-graded)" }),
    el("option", { value: "link", text: "Use a Google Form or other link" }),
  ]);
  kindSelect.value = test.kind ?? "builtin";

  const linkField = labelled("Test link", linkInput);
  const syncKind = () => {
    linkField.hidden = kindSelect.value !== "link";
    shuffleFields.hidden = kindSelect.value === "link";
  };
  kindSelect.addEventListener("change", syncKind);
  syncKind();

  const saveBtn = el("button", { type: "button", className: "edit-btn", text: "Save" });
  const cancelBtn = el("button", { type: "button", className: "secondary", text: "Cancel" });

  saveBtn.addEventListener("click", async () => {
    const title = titleInput.value.trim();
    const subject = subjectInput.value.trim();
    const kind = kindSelect.value;
    const link = linkInput.value.trim();

    if (!title || !subject) {
      toast("A test needs a title and a subject.", "error");
      return;
    }
    if (kind === "link" && !isValidUrl(link)) {
      toast("Paste the http(s) link to your Google Form.", "error");
      return;
    }

    const schedule = readSchedule(durationInput, opensInput, closesInput, test.closes_at);
    if (!schedule) return;

    const minVersion = minVersionInput.value.trim();
    if (minVersion && !/^\d+(\.\d+)*$/.test(minVersion)) {
      toast("Minimum SEB version must be numbers and dots, like 3.9.0.", "error");
      return;
    }

    // Strict without a key refuses everybody, including the students it is
    // meant to protect. Caught here rather than on exam morning.
    if (sebInput.checked && enforcementSelect.value === "strict" && !bekInput.value.trim()) {
      toast("Strict needs a Browser Exam Key, or nobody will be able to open the test.", "error");
      return;
    }

    const updated = {
      ...test,
      title,
      subject,
      kind,
      form_url: kind === "link" ? link : null,
      requires_seb: sebInput.checked,
      ...schedule,
    };

    const reset = setBusy(saveBtn, "Saving...");

    try {
      const { error } = await supabase
        .from("tests")
        .update({
          title,
          subject,
          kind,
          form_url: updated.form_url,
          requires_seb: updated.requires_seb,
          // Only sent when set, so editing a test still works before 0017 is run.
          ...(Number(negativeSelect.value) > 0 || test.negative_marking
            ? { negative_marking: Number(negativeSelect.value) }
            : {}),
          ...(shuffleQInput.checked || test.shuffle_questions
            ? { shuffle_questions: kind === "builtin" && shuffleQInput.checked }
            : {}),
          ...(shuffleOptInput.checked || test.shuffle_options
            ? { shuffle_options: kind === "builtin" && shuffleOptInput.checked }
            : {}),
          ...(enforcementSelect.value === "strict" || test.seb_enforcement
            ? { seb_enforcement: enforcementSelect.value }
            : {}),
          ...(minVersionInput.value.trim() || test.seb_min_version
            ? { seb_min_version: minVersionInput.value.trim() || null }
            : {}),
          ...schedule,
        })
        .eq("id", test.id);
      if (error) throw error;

      // The exam key is a secret, so it is written to test_lockdown rather
      // than to `tests`, which every student on the test can read.
      if (bekInput.value.trim() || lock.seb_browser_exam_key) {
        const { error: lockError } = await supabase.from("test_lockdown").upsert({
          test_id: test.id,
          seb_browser_exam_key: bekInput.value.trim() || null,
          updated_at: new Date().toISOString(),
        });
        if (lockError) throw lockError;
      }

      // A live test's config now describes the old settings, so rebuild it
      // before a student can download the stale one.
      if (updated.status === "published" && updated.requires_seb) {
        await refreshLockdown(updated);
      }

      toast("Test updated.", "success");
      await onDone();
    } catch (err) {
      console.error("Update test failed:", err);
      toast(
        isMissingColumn(err)
          ? "Run the newest migrations in supabase/migrations/ first (0021 adds SEB key checks)."
          : errorMessage(err, "Could not update the test."),
        "error"
      );
      reset();
    }
  });

  cancelBtn.addEventListener("click", onDone);

  return el("article", { className: "test-card test-card-editing" }, [
    el("div", { className: "form-stack" }, [
      labelled("Title", titleInput),
      labelled("Subject", subjectInput),
      labelled("Questions", kindSelect),
      linkField,
      shuffleFields,
      labelled(
        "Negative marking",
        negativeSelect,
        "Wrong answers on choice and numerical questions."
      ),
      labelled("Maximum time (minutes)", durationInput, "Blank means no time limit."),
      labelled("Start time", opensInput, "Blank means available as soon as it is published."),
      labelled("Deadline", closesInput, "Blank means no deadline."),
      el("label", { className: "checkbox-field" }, [
        sebInput,
        el("span", { text: "Protect with Safe Exam Browser" }),
      ]),
      sebFields,
    ]),
    el("div", { className: "admin-actions" }, [saveBtn, cancelBtn]),
  ]);
}

/** Draft / Scheduled / Live / Closed, as a coloured pill next to the title. */
function statusPill(test) {
  if (test.status !== "published") return { text: "Draft", tone: "draft" };

  const { state } = testWindow(test);
  if (state === "closed") return { text: "Closed", tone: "closed" };
  // Published but waiting for its start time — visible to students, not yet
  // openable, which is neither "Draft" nor "Live".
  if (state === "upcoming") return { text: "Scheduled", tone: "scheduled" };

  return { text: "Live", tone: "live" };
}

/** The grey lines under a test's title: what it is, when it runs, how to quit. */
function testDetails(test) {
  const lines = [];

  if (test.kind === "link") {
    lines.push("Google Form or external link — marked outside this portal");
  } else {
    const count = questionCounts.get(test.id) ?? 0;
    lines.push(countLabel(count, "question") + (count ? " · auto-graded" : " · none yet"));
  }

  const timing = [];
  if (test.duration_minutes) timing.push(formatDuration(test.duration_minutes));
  const penalty = penaltyLabel(test.negative_marking);
  if (penalty) timing.push(`wrong answers lose ${penalty}`);
  if (test.opens_at) timing.push(`opens ${formatDateTime(test.opens_at)}`);
  if (test.closes_at) timing.push(`closes ${formatDateTime(test.closes_at)}`);
  lines.push(timing.length ? timing.join(" · ") : "No time limit or schedule");

  if (test.audience === "selected") {
    const count = audienceCounts.get(test.id) ?? 0;
    lines.push(
      count
        ? `Limited to ${countLabel(count, "student")}`
        : "Limited — but nobody is selected, so no one can see it"
    );
  } else {
    lines.push("Available to everyone");
  }

  if (test.requires_seb === false) {
    lines.push("Opens in any browser");
  } else if (!test.seb_config_url) {
    lines.push("Safe Exam Browser — lockdown config is built when you publish");
  } else {
    const password = quitPasswords.get(test.id);
    lines.push(
      password
        ? `Safe Exam Browser · quit password ${password}`
        : "Safe Exam Browser · quit password set at publish"
    );
  }

  return lines;
}

function testCard(test) {
  const pill = statusPill(test);
  const published = test.status === "published";

  const editBtn = el("button", { type: "button", className: "edit-btn", text: "Edit" });
  const deleteBtn = el("button", { type: "button", className: "delete-btn", text: "Delete" });
  const statusBtn = el("button", {
    type: "button",
    className: published ? "secondary" : "edit-btn",
    text: published ? "Unpublish" : "Publish",
  });

  const actions = [];

  if (test.kind !== "link") {
    const questionsBtn = el("button", { type: "button", className: "edit-btn", text: "Questions" });

    // The editor takes over the panel so it gets the full width.
    questionsBtn.addEventListener("click", () => {
      adminTestsList.hidden = true;
      questionEditor.hidden = false;
      openQuestionEditor(questionEditor, test, () => {
        questionEditor.hidden = true;
        questionEditor.replaceChildren();
        adminTestsList.hidden = false;
        loadTests();
      });
    });

    actions.push(questionsBtn);
  }

  const audienceBtn = el("button", { type: "button", className: "edit-btn", text: "Audience" });
  audienceBtn.addEventListener("click", () => {
    adminTestsList.hidden = true;
    questionEditor.hidden = false;
    openAudienceEditor(questionEditor, test, () => {
      questionEditor.hidden = true;
      questionEditor.replaceChildren();
      adminTestsList.hidden = false;
      loadTests();
    });
  });

  actions.push(audienceBtn, editBtn, statusBtn);

  if (test.requires_seb !== false) {
    // Rebuilds and re-hosts the .seb file. Needed whenever something the
    // config must allow changes — most often the address this portal is
    // served from — because a stale config silently blocks the exam from
    // inside Safe Exam Browser, which looks to a student like a failed login.
    const refreshBtn = el("button", {
      type: "button",
      className: "edit-btn",
      text: "Refresh lockdown",
    });

    refreshBtn.addEventListener("click", async () => {
      const reset = setBusy(refreshBtn, "Refreshing...");
      try {
        await refreshLockdown(test);
        toast("Lockdown config refreshed.", "success");
        await loadTests();
      } catch (err) {
        console.error("Refresh config failed:", err);
        toast(
          isMissingSebBucket(err)
            ? "Run supabase/migrations/0006_seb_config_storage.sql first."
            : errorMessage(err, "Could not refresh the lockdown config."),
          "error"
        );
      } finally {
        reset();
      }
    });

    actions.push(refreshBtn);
  }

  // Teaching a test what a genuine Safe Exam Browser looks like means opening
  // it inside one. The student dashboard hides Start until the exam window
  // opens, so without this there is no way to set up verification in advance —
  // which is the only time it is any use. get_exam() already lets a teacher
  // in whatever the clock says, so this button is the missing half.
  if (published && test.requires_seb !== false) {
    const verified = Boolean(lockdowns.get(test.id)?.seb_fingerprint);
    const verifyBtn = el("button", {
      type: "button",
      className: "edit-btn",
      text: verified ? "Re-check SEB" : "Set up SEB check",
    });

    verifyBtn.addEventListener("click", () => {
      if (!test.seb_config_url) {
        toast("Press Refresh lockdown first, so there is a config to launch.", "error");
        return;
      }
      openSebGate(test);
    });

    actions.push(verifyBtn);
  }

  actions.push(deleteBtn);

  const card = el("article", { className: "test-card" }, [
    el("div", { className: "test-info" }, [
      el("div", { className: "test-title-row" }, [
        el("h4", { text: test.title }),
        el("span", { className: `pill pill-${pill.tone}`, text: pill.text }),
      ]),
      el("p", { text: test.subject }),
      ...testDetails(test).map(text => el("small", { className: "seb-note", text })),
      ...(test.requires_seb !== false
        ? [
            el("small", {
              className: `seb-note ${lockdowns.get(test.id)?.seb_fingerprint ? "is-ok" : ""}`,
              text: lockdowns.get(test.id)?.seb_fingerprint
                ? "SEB check active — a forged browser cannot open this test."
                : "SEB check not set up — open this test in SEB once to switch it on.",
            }),
          ]
        : []),
    ]),
    el("div", { className: "admin-actions" }, actions),
  ]);

  statusBtn.addEventListener("click", () =>
    setStatus(test, published ? "draft" : "published", statusBtn)
  );

  editBtn.addEventListener("click", () => {
    card.replaceWith(editForm(test, loadTests));
  });

  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Delete "${test.title}"? This cannot be undone.`)) return;

    const reset = setBusy(deleteBtn, "Deleting...");
    const { error } = await supabase.from("tests").delete().eq("id", test.id);

    if (error) {
      reset();
      console.error("Delete test failed:", error.message);
      toast(errorMessage(error, "Could not delete the test."), "error");
      return;
    }

    // Leaves no orphaned config behind in storage.
    await removeSebConfig(supabase, test.id);
    reset();

    toast("Test deleted.", "success");
    await Promise.all([loadTests(), loadStats()]);
  });

  return card;
}

function resultCard(result, test) {
  const seb = sebBadge({
    requiresSeb: test?.requires_seb,
    viaSeb: result.via_seb,
    sebApi: result.seb_api,
  });

  return el("article", { className: "result-card" }, [
    el("div", {}, [
      el("div", { className: "test-title-row" }, [
        el("h4", { text: test?.title || "Test" }),
        ...(seb ? [seb] : []),
      ]),
      el("p", { text: result.email }),
    ]),
    el("div", {
      className: "score-badge",
      text: `${result.score}/${result.total} (${result.percentage}%)`,
    }),
  ]);
}

/** How many questions each test has, so Publish can refuse an empty paper. */
const questionCounts = new Map();

/** Quit passwords, admin-only, shown on the card so a teacher can read one out. */
const quitPasswords = new Map();
/** test_id -> its SEB verification row, which only teachers may read. */
const lockdowns = new Map();

/** How many students each limited test is assigned to. */
const audienceCounts = new Map();

async function loadTests() {
  setNotice(adminTestsList, "Loading tests...");

  const [tests, counts, secrets, audience, locks] = await Promise.all([
    supabase.from("tests").select("*").order("created_at", { ascending: false }),
    supabase.from("questions").select("test_id"),
    supabase.from("test_secrets").select("test_id, quit_password"),
    supabase.from("test_audience").select("test_id"),
    // Verification material lives here rather than on `tests`, which students
    // are allowed to read. Missing before 0024, hence the tolerated error.
    supabase
      .from("test_lockdown")
      .select("test_id, seb_fingerprint, seb_fingerprint_at, seb_browser_exam_key"),
  ]);

  if (tests.error) {
    console.error("Error loading tests:", tests.error.message);
    setNotice(adminTestsList, "Could not load tests.", "error");
    return;
  }

  // Counted here rather than with a PostgREST aggregate, which would need one
  // request per test. Missing counts only ever show as "none yet".
  questionCounts.clear();
  for (const row of counts.data ?? []) {
    questionCounts.set(row.test_id, (questionCounts.get(row.test_id) ?? 0) + 1);
  }

  // Absent until migration 0008 has run; the cards cope with an empty map.
  quitPasswords.clear();
  for (const row of secrets.data ?? []) quitPasswords.set(row.test_id, row.quit_password);

  lockdowns.clear();
  for (const row of locks.data ?? []) lockdowns.set(row.test_id, row);

  // Absent until 0014; a test with no rows simply reads as "nobody selected".
  audienceCounts.clear();
  if (audience.error && !isMissingAudience(audience.error)) {
    console.error("Could not load test audiences:", audience.error.message);
  }
  for (const row of audience.data ?? []) {
    audienceCounts.set(row.test_id, (audienceCounts.get(row.test_id) ?? 0) + 1);
  }

  const rows = tests.data ?? [];
  adminTestsCount.textContent = countLabel(rows.length, "test");
  renderList(adminTestsList, rows, testCard, "No tests have been created yet.");
}

async function loadResults() {
  setNotice(adminResultsList, "Loading results...");

  // Joined client-side rather than with a PostgREST embed (`tests (title)`).
  // The embed needs a foreign key from results.test_id to tests.id, which this
  // schema does not declare, so it fails with "Could not find a relationship".
  // The dashboard resolves titles the same way.
  const [results, tests] = await Promise.all([
    supabase
      .from("results")
      .select("test_id, email, score, total, percentage, attempted_at, via_seb, seb_api")
      .order("attempted_at", { ascending: false }),
    supabase.from("tests").select("id, title, requires_seb"),
  ]);

  if (results.error) {
    console.error("Error loading results:", results.error.message);
    setNotice(adminResultsList, "Could not load results.", "error");
    return;
  }

  if (tests.error) {
    console.error("Error loading test titles:", tests.error.message);
  }

  const testsById = new Map((tests.data ?? []).map(test => [test.id, test]));
  const rows = results.data ?? [];

  adminResultsCount.textContent = countLabel(rows.length, "result");
  renderList(
    adminResultsList,
    rows,
    result => resultCard(result, testsById.get(result.test_id)),
    "No results yet."
  );
}

async function loadStats() {
  const [tests, attempts, scores, videos] = await Promise.all([
    supabase.from("tests").select("*", { count: "exact", head: true }),
    supabase.from("results").select("*", { count: "exact", head: true }),
    supabase.from("results").select("percentage"),
    supabase.from("videos").select("*", { count: "exact", head: true }),
  ]);

  // The videos table may not exist yet; that must not blank the other tiles.
  totalVideos.textContent = videos.error ? "0" : (videos.count ?? 0);

  if (tests.error || attempts.error || scores.error) {
    console.error("Error loading stats:", (tests.error || attempts.error || scores.error).message);
    return;
  }

  const percentages = (scores.data ?? []).map(row => Number(row.percentage) || 0);
  const average = percentages.length
    ? percentages.reduce((sum, value) => sum + value, 0) / percentages.length
    : 0;

  totalTests.textContent = tests.count ?? 0;
  totalAttempts.textContent = attempts.count ?? 0;
  avgScore.textContent = `${Math.round(average)}%`;
}

function readVideoForm() {
  const title = videoTitle.value.trim();
  const subject = videoSubject.value.trim();
  const url = videoLink.value.trim();

  if (!title || !subject || !url) {
    toast("Title, subject and video link are all required.", "error");
    return null;
  }
  if (!isValidUrl(url)) {
    toast("Enter a valid http(s) video link.", "error");
    return null;
  }
  return {
    title,
    subject,
    description: videoDescription.value.trim() || null,
    video_url: url,
  };
}

addVideoBtn.addEventListener("click", async () => {
  const payload = readVideoForm();
  if (!payload) return;

  const reset = setBusy(addVideoBtn, "Adding...");
  const { error } = await supabase.from("videos").insert([payload]);
  reset();

  if (error) {
    console.error("Create video failed:", error.message);
    toast(
      isMissingTable(error)
        ? "Run supabase/migrations/0003_videos.sql to enable video lessons."
        : errorMessage(error, "Could not add the video."),
      "error"
    );
    return;
  }

  videoTitle.value = "";
  videoSubject.value = "";
  videoDescription.value = "";
  videoLink.value = "";
  toast("Video added.", "success");

  await Promise.all([loadVideos(), loadStats()]);
});

function videoCard(video) {
  const media = describeVideo(video.video_url);
  const deleteBtn = el("button", { type: "button", className: "delete-btn", text: "Delete" });

  const meta = [
    el("h4", { text: video.title }),
    el("p", { text: video.subject }),
    el("small", { text: `${media.provider}${video.description ? " — " + video.description : ""}` }),
  ];

  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Delete "${video.title}"? This cannot be undone.`)) return;

    const reset = setBusy(deleteBtn, "Deleting...");
    const { error } = await supabase.from("videos").delete().eq("id", video.id);
    reset();

    if (error) {
      console.error("Delete video failed:", error.message);
      toast(errorMessage(error, "Could not delete the video."), "error");
      return;
    }

    toast("Video deleted.", "success");
    await Promise.all([loadVideos(), loadStats()]);
  });

  return el("article", { className: "test-card" }, [
    el("div", { className: "test-info" }, meta),
    el("div", { className: "admin-actions" }, [deleteBtn]),
  ]);
}

async function loadVideos() {
  setNotice(adminVideosList, "Loading videos...");

  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error loading videos:", error.message);
    setNotice(
      adminVideosList,
      isMissingTable(error)
        ? setupHint("Video lessons", "0003_videos.sql")
        : "Could not load videos.",
      "error"
    );
    return;
  }

  const videos = data ?? [];
  adminVideosCount.textContent = countLabel(videos.length, "video");
  renderList(adminVideosList, videos, videoCard, "No videos have been added yet.");
}

addNoticeBtn.addEventListener("click", async () => {
  const title = noticeTitle.value.trim();
  const body = noticeBody.value.trim();

  if (!title || !body) {
    toast("A notice needs both a title and a message.", "error");
    return;
  }

  const reset = setBusy(addNoticeBtn, "Posting...");
  const { error } = await supabase.from("notices").insert([
    {
      title,
      body,
      pinned: noticePinned.checked,
      category: noticeCategory.value,
      priority: noticePriority.value,
    },
  ]);
  reset();

  if (error) {
    console.error("Post notice failed:", error.message);
    toast(
      isMissingTable(error) || isMissingColumn(error)
        ? "Run supabase/migrations/0009_analytics_and_notices.sql to enable the notice board."
        : errorMessage(error, "Could not post the notice."),
      "error"
    );
    return;
  }

  noticeTitle.value = "";
  noticeBody.value = "";
  noticePinned.checked = false;
  noticeCategory.value = "general";
  noticePriority.value = "normal";
  toast("Notice posted.", "success");
  await loadNotices();
});

function deleteNoticeBtn(notice) {
  const button = el("button", { type: "button", className: "delete-btn", text: "Delete" });

  button.addEventListener("click", async () => {
    if (!confirm(`Delete "${notice.title}"? This cannot be undone.`)) return;

    const reset = setBusy(button, "Deleting...");
    const { error } = await supabase.from("notices").delete().eq("id", notice.id);
    reset();

    if (error) {
      console.error("Delete notice failed:", error.message);
      toast(errorMessage(error, "Could not delete the notice."), "error");
      return;
    }

    toast("Notice deleted.", "success");
    await loadNotices();
  });

  return button;
}

async function loadNotices() {
  setNotice(adminNoticesList, "Loading notices...");

  // Ordering is applied by sortNotices() below, which is shared with the
  // student board so the two lists cannot disagree about what comes first.
  const { data, error } = await supabase
    .from("notices")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error loading notices:", error.message);
    setNotice(
      adminNoticesList,
      isMissingTable(error)
        ? setupHint("Notices", "0004_notices_assignments.sql")
        : "Could not load notices.",
      "error"
    );
    return;
  }

  const notices = sortNotices(data ?? []);
  adminNoticesCount.textContent = countLabel(notices.length, "notice");

  // Rendered with the student's own component, so a teacher composing a notice
  // sees exactly what the class will see rather than an admin-only summary.
  renderList(
    adminNoticesList,
    notices,
    notice => noticeCard(notice, [deleteNoticeBtn(notice)]),
    "No notices have been posted yet."
  );
}

addAssignmentBtn.addEventListener("click", async () => {
  const title = assignmentTitle.value.trim();
  const subject = assignmentSubject.value.trim();
  const link = assignmentLink.value.trim();

  if (!title || !subject) {
    toast("An assignment needs a title and a subject.", "error");
    return;
  }
  if (link && !isValidUrl(link)) {
    toast("Enter a valid http(s) link, or leave it blank.", "error");
    return;
  }

  const reset = setBusy(addAssignmentBtn, "Adding...");
  const { error } = await supabase.from("assignments").insert([
    {
      title,
      subject,
      description: assignmentDescription.value.trim() || null,
      due_date: assignmentDue.value || null,
      link_url: link || null,
      accepts_submissions: assignmentAccepts.checked,
    },
  ]);
  reset();

  if (error) {
    console.error("Create assignment failed:", error.message);
    toast(
      isMissingColumn(error)
        ? "Run supabase/migrations/0010_assignment_submissions.sql to enable hand-ins."
        : isMissingTable(error)
          ? setupHint("Assignments", "0004_notices_assignments.sql")
          : errorMessage(error, "Could not add the assignment."),
      "error"
    );
    return;
  }

  [
    assignmentTitle,
    assignmentSubject,
    assignmentDescription,
    assignmentDue,
    assignmentLink,
  ].forEach(input => (input.value = ""));
  assignmentAccepts.checked = false;
  toast("Assignment added.", "success");
  await loadAssignments();
});

/** Hand-ins for the whole class, keyed by assignment id. */
let submissionsByAssignment = new Map();

/** One student's hand-in, as a row in the expanded list. */
function submissionRow(submission, dueDate) {
  // Students are blocked after the deadline, so this can only appear on work
  // handed in before that rule existed, or where a teacher has since brought
  // the due date forward.
  const deadline = submissionDeadline(dueDate);
  const late =
    deadline && new Date(submission.submitted_at) > deadline
      ? el("span", { className: "pill pill-closed", text: "Late" })
      : null;

  const meta = [el("span", { text: relativeTime(submission.updated_at) })];
  if (submission.note)
    meta.push(el("span", { className: "dot" }), el("span", { text: submission.note }));

  return el("article", { className: "submission-row" }, [
    el("div", { className: "submission-who" }, [
      el("span", { className: "cell-email", text: submission.email }),
      ...(late ? [late] : []),
    ]),
    el("div", { className: "submission-detail" }, meta),
    el("a", {
      className: "edit-btn",
      href: submission.link_url,
      target: "_blank",
      rel: "noreferrer",
      text: "Open work",
    }),
  ]);
}

function assignmentCard(assignment) {
  const handIns = submissionsByAssignment.get(assignment.id) ?? [];

  const info = [
    el("h4", { text: assignment.title }),
    el("p", { text: assignment.subject }),
    el("small", { className: "seb-note", text: dueStatus(assignment.due_date).label }),
  ];

  if (assignment.accepts_submissions) {
    const closed = isPastDue(assignment.due_date);
    const deadline = submissionDeadline(assignment.due_date);

    info.push(
      el("small", {
        className: "seb-note",
        text: handIns.length
          ? `${countLabel(handIns.length, "hand-in")} received`
          : "Accepting hand-ins — none yet",
      })
    );

    // Whether students can still write is the thing a teacher needs before
    // deciding to extend the due date, so it is stated rather than inferred
    // from the due badge above.
    info.push(
      el("small", {
        className: "seb-note",
        text: closed
          ? "Closed — students can no longer submit or change their work"
          : deadline
            ? `Open until ${formatDateTime(deadline)}`
            : "Open — no deadline set",
      })
    );
  }

  const actions = [];
  const list = el("div", { className: "submission-list", hidden: true });

  if (assignment.accepts_submissions && handIns.length) {
    const toggle = el("button", {
      type: "button",
      className: "edit-btn",
      text: `View ${countLabel(handIns.length, "hand-in")}`,
    });

    toggle.addEventListener("click", () => {
      list.hidden = !list.hidden;
      toggle.textContent = list.hidden
        ? `View ${countLabel(handIns.length, "hand-in")}`
        : "Hide hand-ins";
    });

    list.replaceChildren(...handIns.map(row => submissionRow(row, assignment.due_date)));
    actions.push(toggle);
  }

  const deleteBtn = el("button", { type: "button", className: "delete-btn", text: "Delete" });

  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Delete "${assignment.title}"? This cannot be undone.`)) return;

    const reset = setBusy(deleteBtn, "Deleting...");
    const { error } = await supabase.from("assignments").delete().eq("id", assignment.id);
    reset();

    if (error) {
      console.error("Delete assignment failed:", error.message);
      toast(errorMessage(error, "Could not delete it."), "error");
      return;
    }

    toast("Deleted.", "success");
    await loadAssignments();
  });

  actions.push(deleteBtn);

  return el("article", { className: "test-card assignment-card-block" }, [
    el("div", { className: "assignment-top" }, [
      el("div", { className: "test-info" }, info),
      el("div", { className: "admin-actions" }, actions),
    ]),
    list,
  ]);
}

async function loadAssignments() {
  setNotice(adminAssignmentsList, "Loading assignments...");

  const [{ data, error }, submissions] = await Promise.all([
    supabase
      .from("assignments")
      .select("*")
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase.from("assignment_submissions").select("*").order("updated_at", { ascending: false }),
  ]);

  // Hand-ins are extra detail. Without migration 0010 the assignment list must
  // still render, just with no submission counts.
  submissionsByAssignment = new Map();
  if (submissions.error) {
    if (!isMissingSubmissions(submissions.error)) {
      console.error("Could not load submissions:", submissions.error.message);
    }
  } else {
    for (const row of submissions.data ?? []) {
      if (!submissionsByAssignment.has(row.assignment_id)) {
        submissionsByAssignment.set(row.assignment_id, []);
      }
      submissionsByAssignment.get(row.assignment_id).push(row);
    }
  }

  if (error) {
    console.error("Error loading assignments:", error.message);
    setNotice(
      adminAssignmentsList,
      isMissingTable(error)
        ? setupHint("Assignments", "0004_notices_assignments.sql")
        : "Could not load assignments.",
      "error"
    );
    return;
  }

  const assignments = data ?? [];
  adminAssignmentsCount.textContent = countLabel(assignments.length, "assignment");

  renderList(
    adminAssignmentsList,
    assignments,
    assignment => assignmentCard(assignment),
    "No assignments have been set yet."
  );
}

await Promise.all([
  loadTests(),
  loadResults(),
  loadVideos(),
  loadNotices(),
  loadAssignments(),
  loadStats(),
]);
