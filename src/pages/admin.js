import { supabase, isMissingTable, setupHint } from "../lib/supabase.js";
import { requireAdmin, wireLogout } from "../lib/session.js";
import { describeVideo } from "../lib/video.js";
import {
  dueStatus,
  formatDateTime,
  formatDuration,
  fromDatetimeLocal,
  isClosed,
  isPastDue,
  relativeTime,
  submissionDeadline,
  toDatetimeLocal,
} from "../lib/dates.js";
import {
  generateQuitPassword,
  isMissingSebBucket,
  publishSebConfig,
  removeSebConfig,
} from "../lib/seb.js";
import { openQuestionEditor } from "../lib/questionEditor.js";
import { changePasswordSection } from "../lib/password.js";
import { noticeCard, sortNotices } from "../lib/noticeBoard.js";
import { isMissingSubmissions } from "../lib/assignmentSubmit.js";
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
const testDuration = document.getElementById("testDuration");
const testCloses = document.getElementById("testCloses");
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
function readSchedule(durationInput, closesInput, current = null) {
  const raw = durationInput.value.trim();
  let duration = null;

  if (raw) {
    duration = Number(raw);
    if (!Number.isInteger(duration) || duration < 1 || duration > 600) {
      toast("Maximum time must be a whole number of minutes, from 1 to 600.", "error");
      return null;
    }
  }

  const closesAt = fromDatetimeLocal(closesInput.value);
  const unchanged = closesAt === current || toDatetimeLocal(current) === closesInput.value;

  // A newly set deadline in the past would hide the test the moment it is
  // published. Unpublish is the way to close a test early.
  if (closesAt && !unchanged && new Date(closesAt) <= new Date()) {
    toast("That deadline has already passed. Pick a later one.", "error");
    return null;
  }

  return { duration_minutes: duration, closes_at: closesAt };
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

  const schedule = readSchedule(testDuration, testCloses);
  if (!schedule) return null;

  return {
    title,
    subject,
    kind,
    form_url: kind === "link" ? link : null,
    requires_seb: testRequiresSeb.checked,
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
        ? "Run supabase/migrations/0008_exam_delivery.sql to enable drafts and deadlines."
        : errorMessage(error, "Could not create the test."),
      "error"
    );
    return;
  }

  testTitle.value = "";
  testSubject.value = "";
  testLink.value = "";
  testDuration.value = "";
  testCloses.value = "";
  testRequiresSeb.checked = true;
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
  return error?.code === "42703" || /column .* does not exist/i.test(error?.message ?? "");
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
  const closesInput = el("input", {
    type: "datetime-local",
    value: toDatetimeLocal(test.closes_at),
  });
  const sebInput = el("input", { type: "checkbox", checked: test.requires_seb !== false });

  const kindSelect = el("select", {}, [
    el("option", { value: "builtin", text: "Write them here (auto-graded)" }),
    el("option", { value: "link", text: "Use a Google Form or other link" }),
  ]);
  kindSelect.value = test.kind ?? "builtin";

  const linkField = labelled("Test link", linkInput);
  const syncKind = () => (linkField.hidden = kindSelect.value !== "link");
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

    const schedule = readSchedule(durationInput, closesInput, test.closes_at);
    if (!schedule) return;

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
          ...schedule,
        })
        .eq("id", test.id);
      if (error) throw error;

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
          ? "Run supabase/migrations/0008_exam_delivery.sql first."
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
      labelled("Maximum time (minutes)", durationInput, "Blank means no time limit."),
      labelled("Deadline", closesInput, "Blank means no deadline."),
      el("label", { className: "checkbox-field" }, [
        sebInput,
        el("span", { text: "Protect with Safe Exam Browser" }),
      ]),
    ]),
    el("div", { className: "admin-actions" }, [saveBtn, cancelBtn]),
  ]);
}

/** Draft / Live / Closed, as a coloured pill next to the title. */
function statusPill(test) {
  if (test.status !== "published") return { text: "Draft", tone: "draft" };
  if (isClosed(test)) return { text: "Closed", tone: "closed" };
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
  if (test.closes_at) timing.push(`closes ${formatDateTime(test.closes_at)}`);
  lines.push(timing.length ? timing.join(" · ") : "No time limit or deadline");

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

  actions.push(editBtn, statusBtn);

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

  actions.push(deleteBtn);

  const card = el("article", { className: "test-card" }, [
    el("div", { className: "test-info" }, [
      el("div", { className: "test-title-row" }, [
        el("h4", { text: test.title }),
        el("span", { className: `pill pill-${pill.tone}`, text: pill.text }),
      ]),
      el("p", { text: test.subject }),
      ...testDetails(test).map(text => el("small", { className: "seb-note", text })),
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

function resultCard(result, title) {
  return el("article", { className: "result-card" }, [
    el("div", {}, [el("h4", { text: title || "Test" }), el("p", { text: result.email })]),
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

async function loadTests() {
  setNotice(adminTestsList, "Loading tests...");

  const [tests, counts, secrets] = await Promise.all([
    supabase.from("tests").select("*").order("created_at", { ascending: false }),
    supabase.from("questions").select("test_id"),
    supabase.from("test_secrets").select("test_id, quit_password"),
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
      .select("test_id, email, score, total, percentage, attempted_at")
      .order("attempted_at", { ascending: false }),
    supabase.from("tests").select("id, title"),
  ]);

  if (results.error) {
    console.error("Error loading results:", results.error.message);
    setNotice(adminResultsList, "Could not load results.", "error");
    return;
  }

  if (tests.error) {
    console.error("Error loading test titles:", tests.error.message);
  }

  const titlesById = new Map((tests.data ?? []).map(test => [test.id, test.title]));
  const rows = results.data ?? [];

  adminResultsCount.textContent = countLabel(rows.length, "result");
  renderList(
    adminResultsList,
    rows,
    result => resultCard(result, titlesById.get(result.test_id)),
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
