import { supabase, DEFAULT_AVATAR, isMissingTable, setupHint } from "../lib/supabase.js";
import { requireUser, displayName, wireLogout } from "../lib/session.js";
import { countLabel, el, renderList, setBusy, setNotice, wireTabs } from "../lib/ui.js";
import { describeVideo } from "../lib/video.js";
import { dueStatus, isClosed, scheduleLabel } from "../lib/dates.js";
import { openSebGate } from "../lib/sebGate.js";
import { examAlert } from "../lib/examAlert.js";
import { noticeCard, sortNotices } from "../lib/noticeBoard.js";
import { isMissingSubmissions, submissionBox } from "../lib/assignmentSubmit.js";

const welcomeText = document.getElementById("welcomeText");
const profileIcon = document.getElementById("profileIcon");
const testsList = document.getElementById("testsList");
const resultsList = document.getElementById("resultsList");
const testsCount = document.getElementById("testsCount");
const resultsCount = document.getElementById("resultsCount");
const videosList = document.getElementById("videosList");
const videosCount = document.getElementById("videosCount");
const videoSearch = document.getElementById("videoSearch");
const noticesList = document.getElementById("noticesList");
const noticesCount = document.getElementById("noticesCount");
const assignmentsList = document.getElementById("assignmentsList");
const assignmentsCount = document.getElementById("assignmentsCount");
const examAlertMount = document.getElementById("examAlert");

const user = await requireUser();

welcomeText.textContent = `Welcome, ${displayName(user)}`;
profileIcon.src = user.user_metadata?.photo || DEFAULT_AVATAR;
profileIcon.alt = `${displayName(user)} profile picture`;
wireLogout();
wireTabs(document.querySelector('[role="tablist"]'));

function videoCard(video) {
  const media = describeVideo(video.video_url);

  const player =
    media.kind === "embed"
      ? el("div", { className: "video-frame" }, [
          el("iframe", {
            src: media.embedUrl,
            title: video.title,
            loading: "lazy",
            allow: "accelerometer; encrypted-media; picture-in-picture; fullscreen",
            allowFullscreen: true,
            referrerPolicy: "strict-origin-when-cross-origin",
          }),
        ])
      : el("a", {
          className: "start-btn video-link",
          href: media.href,
          target: "_blank",
          rel: "noreferrer",
          text: media.href ? `Open on ${media.provider}` : "Video unavailable",
        });

  const meta = [el("h4", { text: video.title }), el("p", { text: video.subject })];
  if (video.description) meta.push(el("small", { text: video.description }));

  return el("article", { className: "video-card" }, [player, el("div", {}, meta)]);
}

function testCard(test) {
  const info = [el("h4", { text: test.title }), el("p", { text: test.subject })];

  const schedule = scheduleLabel(test);
  if (schedule) info.push(el("small", { className: "seb-note", text: schedule }));

  // Past the deadline there is nothing to start, and the server would refuse
  // anyway — say so here rather than letting the student find out inside SEB.
  if (isClosed(test)) {
    return el("article", { className: "test-card test-card-closed" }, [
      el("div", { className: "test-info" }, info),
      el("span", { className: "due-badge due-overdue", text: "Closed" }),
    ]);
  }

  // Tests default to requiring SEB; only an explicit false opens directly.
  if (test.requires_seb === false) {
    return el("article", { className: "test-card" }, [
      el("div", { className: "test-info" }, info),
      el("a", {
        className: "start-btn",
        href: `exam.html?test=${encodeURIComponent(test.id)}`,
        text: "Start Test",
      }),
    ]);
  }

  info.push(el("small", { className: "seb-note", text: "Requires Safe Exam Browser" }));

  // A button, not a link: the gate must run before the exam URL is opened.
  const startBtn = el("button", {
    type: "button",
    className: "start-btn",
    text: "Start Test",
  });

  startBtn.addEventListener("click", async () => {
    const reset = setBusy(startBtn, "Checking...");
    try {
      await openSebGate(test);
    } finally {
      reset();
    }
  });

  return el("article", { className: "test-card" }, [
    el("div", { className: "test-info" }, info),
    startBtn,
  ]);
}

function resultCard(result, test) {
  const attemptedAt = result.attempted_at ? new Date(result.attempted_at) : null;
  const dateText =
    attemptedAt && !Number.isNaN(attemptedAt.valueOf()) ? attemptedAt.toLocaleDateString() : "";

  return el("article", { className: "result-card" }, [
    el("div", {}, [
      el("h4", { text: test?.title || "Test" }),
      el("p", { text: test?.subject || "Subject not available" }),
      el("small", { text: dateText }),
    ]),
    el("div", {
      className: "score-badge",
      text: `${result.score}/${result.total} (${result.percentage}%)`,
    }),
  ]);
}

let allVideos = [];

function renderVideos() {
  const term = (videoSearch?.value ?? "").trim().toLowerCase();
  const shown = term
    ? allVideos.filter(video =>
        `${video.title} ${video.subject} ${video.description ?? ""}`.toLowerCase().includes(term)
      )
    : allVideos;

  videosCount.textContent = countLabel(shown.length, "video");
  renderList(
    videosList,
    shown,
    videoCard,
    term
      ? `No lessons match "${videoSearch.value.trim()}".`
      : "No video lessons have been added yet."
  );
}

async function loadVideos() {
  setNotice(videosList, "Loading lessons...");

  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error loading videos:", error.message);
    setNotice(
      videosList,
      isMissingTable(error)
        ? setupHint("Video lessons", "0003_videos.sql")
        : "Could not load video lessons. Please refresh and try again.",
      "error"
    );
    return;
  }

  allVideos = data ?? [];
  renderVideos();
}

videoSearch?.addEventListener("input", renderVideos);

async function loadNotices() {
  setNotice(noticesList, "Loading notices...");

  const { data, error } = await supabase
    .from("notices")
    .select("*")
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error loading notices:", error.message);
    setNotice(
      noticesList,
      isMissingTable(error)
        ? setupHint("Notices", "0004_notices_assignments.sql")
        : "Could not load notices. Please refresh and try again.",
      "error"
    );
    return;
  }

  const notices = sortNotices(data ?? []);
  const urgent = notices.filter(notice => notice.priority === "urgent").length;

  noticesCount.textContent = urgent
    ? `${urgent} urgent · ${countLabel(notices.length, "notice")}`
    : countLabel(notices.length, "notice");

  renderList(
    noticesList,
    notices,
    notice => noticeCard(notice),
    "No notices have been posted yet."
  );
}

/** This student's hand-ins, keyed by assignment id. */
let submissionsByAssignment = new Map();

function assignmentCard(assignment) {
  const due = dueStatus(assignment.due_date);

  const info = [el("h4", { text: assignment.title }), el("p", { text: assignment.subject })];
  if (assignment.description) info.push(el("small", { text: assignment.description }));

  const side = [el("div", { className: `due-badge due-${due.tone}`, text: due.label })];
  if (assignment.link_url) {
    side.push(
      el("a", {
        className: "start-btn",
        href: assignment.link_url,
        target: "_blank",
        rel: "noreferrer",
        text: "Open",
      })
    );
  }

  const top = el("div", { className: "assignment-top" }, [
    el("div", { className: "test-info" }, info),
    el("div", { className: "assignment-side" }, side),
  ]);

  const children = [top];

  if (assignment.accepts_submissions) {
    children.push(
      submissionBox(
        assignment,
        submissionsByAssignment.get(assignment.id) ?? null,
        user.email,
        loadAssignments
      )
    );
  }

  return el("article", { className: "assignment-card assignment-card-block" }, children);
}

async function loadAssignments() {
  setNotice(assignmentsList, "Loading assignments...");

  // Undated assignments sort last rather than first.
  const [{ data, error }, submissions] = await Promise.all([
    supabase
      .from("assignments")
      .select("*")
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase.from("assignment_submissions").select("*").eq("email", user.email),
  ]);

  // Hand-ins are optional extra detail: if that table is not there yet, the
  // assignment list must still render rather than showing an error.
  if (submissions.error && !isMissingSubmissions(submissions.error)) {
    console.error("Could not load submissions:", submissions.error.message);
  }

  submissionsByAssignment = new Map((submissions.data ?? []).map(row => [row.assignment_id, row]));

  if (error) {
    console.error("Error loading assignments:", error.message);
    setNotice(
      assignmentsList,
      isMissingTable(error)
        ? setupHint("Assignments", "0004_notices_assignments.sql")
        : "Could not load assignments. Please refresh and try again.",
      "error"
    );
    return;
  }

  const assignments = data ?? [];
  assignmentsCount.textContent = countLabel(assignments.length, "assignment");
  renderList(assignmentsList, assignments, assignmentCard, "No assignments have been set yet.");
}

/** Swaps in the banner, disposing of the previous one's countdown interval. */
function renderExamAlert(openTests) {
  examAlertMount.firstElementChild?.dispatchEvent(new CustomEvent("exam-alert:dispose"));

  const banner = examAlert(openTests, test =>
    test.requires_seb === false
      ? location.assign(`exam.html?test=${encodeURIComponent(test.id)}`)
      : openSebGate(test)
  );

  examAlertMount.replaceChildren(...(banner ? [banner] : []));
}

async function loadDashboard() {
  setNotice(testsList, "Loading tests...");
  setNotice(resultsList, "Loading results...");

  const [tests, results] = await Promise.all([
    supabase.from("tests").select("*").order("created_at", { ascending: false }),
    supabase.from("results").select("*").eq("email", user.email),
  ]);

  if (tests.error) {
    console.error("Error loading tests:", tests.error.message);
    setNotice(testsList, "Could not load tests. Please refresh and try again.", "error");
  }
  if (results.error) {
    console.error("Error loading results:", results.error.message);
    setNotice(resultsList, "Could not load results. Please refresh and try again.", "error");
  }

  const allTests = tests.data ?? [];
  const allResults = results.data ?? [];
  const testsById = new Map(allTests.map(test => [test.id, test]));
  const attemptedIds = new Set(allResults.map(result => result.test_id));

  if (!tests.error) {
    // Row-level security already hides drafts from students; the filter also
    // keeps them off an admin's own dashboard, where RLS lets them through.
    const pending = allTests.filter(
      test => test.status === "published" && !attemptedIds.has(test.id)
    );
    const open = pending.filter(test => !isClosed(test));

    testsCount.textContent = `${open.length} pending`;

    // Soonest deadline first, so the Tests tab agrees with the banner above it
    // about which test matters most. Undated tests fall to the bottom.
    const ordered = [...pending].sort((a, b) => {
      if (Boolean(a.closes_at) !== Boolean(b.closes_at)) return a.closes_at ? -1 : 1;
      if (!a.closes_at) return 0;
      return new Date(a.closes_at) - new Date(b.closes_at);
    });

    renderList(testsList, ordered, testCard, "No tests are available right now.");
    renderExamAlert(open);
  }

  if (!results.error) {
    const sorted = [...allResults].sort(
      (a, b) => new Date(b.attempted_at) - new Date(a.attempted_at)
    );
    resultsCount.textContent = countLabel(sorted.length, "attempt");
    renderList(
      resultsList,
      sorted,
      result => resultCard(result, testsById.get(result.test_id)),
      "No attempts yet."
    );
  }
}

await Promise.all([loadDashboard(), loadVideos(), loadNotices(), loadAssignments()]);
