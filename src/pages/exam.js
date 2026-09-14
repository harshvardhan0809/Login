import { supabase } from "../lib/supabase.js";
import { requireUser } from "../lib/session.js";
import { el, errorMessage, setBusy, setNotice, toast } from "../lib/ui.js";
import { formatClock, formatCountdown, formatDateTime, formatDuration } from "../lib/dates.js";
import { isRunningInSeb, sebQuitUrl } from "../lib/seb.js";
import { openSebGate } from "../lib/sebGate.js";
import { celebrate } from "../lib/celebrate.js";
import { mathText, setMathText } from "../lib/math.js";

const subjectEl = document.getElementById("examSubject");
const titleEl = document.getElementById("examTitle");
const metaEl = document.getElementById("examMeta");
const stateEl = document.getElementById("examState");
const formEl = document.getElementById("examForm");
const listEl = document.getElementById("questionList");
const answeredEl = document.getElementById("answeredCount");
const submitBtn = document.getElementById("submitBtn");
const resultEl = document.getElementById("examResult");
const backBtn = document.getElementById("backBtn");
const clockEl = document.getElementById("examClock");
const clockValueEl = document.getElementById("examClockValue");

/** Seconds SEB stays open after a submission, so the student sees their score. */
const CLOSE_DELAY_SECONDS = 5;

/**
 * How long a student may wait inside SEB for a test to open.
 *
 * Past this it is kinder to close the browser and let them relaunch than to
 * hold them in a session they cannot leave.
 */
const SEB_WAIT_LIMIT_MS = 2 * 60 * 1000;

backBtn.addEventListener("click", () => location.replace("dashboard.html"));

await requireUser();

const testId = new URLSearchParams(location.search).get("test");

/** Answers keyed by question id: string[] for choices, string for free text. */
const answers = new Map();
let questions = [];
let submitted = false;
let timerId = null;

/**
 * When this exam ends, in *browser* milliseconds.
 *
 * The value comes from the server and is corrected for the difference between
 * the two clocks, so a student who puts their laptop's clock back an hour
 * gains nothing. null means the test is untimed.
 */
let endsAtMs = null;

function stopTimer() {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

/**
 * Inside SEB, close the browser after a short, visible countdown.
 *
 * Navigating to the config's quitURL is what actually quits SEB; the delay
 * only exists so the student can read the screen first. Outside SEB there is
 * nothing to close, so the Back button stands in for it.
 *
 * The countdown is shown, not just waited out. A locked-down browser closing
 * itself with no warning reads as a crash — which is exactly the wrong thing
 * to feel in the ten seconds after finishing an exam.
 */
function closeSeb(container) {
  if (!isRunningInSeb()) return;

  const count = el("span", { className: "close-count", text: String(CLOSE_DELAY_SECONDS) });

  // An SVG ring rather than a bar: it reads as a timer at a glance and needs
  // no width to be legible next to the number it wraps.
  const svgNS = "http://www.w3.org/2000/svg";
  const track = document.createElementNS(svgNS, "circle");
  const sweep = document.createElementNS(svgNS, "circle");
  track.setAttribute("class", "close-ring-track");
  sweep.setAttribute("class", "close-ring-sweep");

  for (const circle of [track, sweep]) {
    circle.setAttribute("cx", "26");
    circle.setAttribute("cy", "26");
    circle.setAttribute("r", "22");
  }

  const circumference = 2 * Math.PI * 22;
  sweep.setAttribute("stroke-dasharray", String(circumference));

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 52 52");
  svg.setAttribute("aria-hidden", "true");
  svg.append(track, sweep);

  const panel = el("div", { className: "close-countdown" }, [
    el("div", { className: "close-ring" }, [svg, count]),
    el("p", { className: "close-label", text: "Safe Exam Browser is closing" }),
  ]);
  container.append(panel);

  const endsAt = performance.now() + CLOSE_DELAY_SECONDS * 1000;
  let frame = null;

  // Driven by animation frames, not a 1s interval: the ring drains smoothly
  // while the number still steps 5, 4, 3, 2, 1.
  const tick = () => {
    const left = endsAt - performance.now();

    if (left <= 0) {
      cancelAnimationFrame(frame);
      location.href = sebQuitUrl();
      return;
    }

    count.textContent = String(Math.ceil(left / 1000));
    sweep.setAttribute(
      "stroke-dashoffset",
      String(circumference * (1 - left / (CLOSE_DELAY_SECONDS * 1000)))
    );
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);
}

function updateAnsweredCount() {
  const done = questions.filter(question => {
    const value = answers.get(question.id);
    return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim());
  }).length;

  answeredEl.textContent = `${done} of ${questions.length} answered`;
  answeredEl.className = done === questions.length ? "sub answered-all" : "sub";
}

function choiceInput(question, option) {
  // Radios for one answer, checkboxes for several — the control itself tells
  // the student how many they may pick.
  const multiple = question.type === "multiple";
  const input = el("input", {
    type: multiple ? "checkbox" : "radio",
    name: `q-${question.id}`,
    value: option.id,
  });

  input.addEventListener("change", () => {
    if (multiple) {
      const chosen = new Set(answers.get(question.id) ?? []);
      input.checked ? chosen.add(option.id) : chosen.delete(option.id);
      answers.set(question.id, [...chosen]);
    } else {
      answers.set(question.id, [option.id]);
    }
    updateAnsweredCount();
  });

  return el("label", { className: "choice" }, [input, setMathText(el("span"), option.text)]);
}

function questionCard(question, index) {
  const points = Number(question.points) || 1;

  const header = el("div", { className: "question-head" }, [
    el("span", { className: "question-number", text: `Q${index + 1}` }),
    // The prompt is stored as LaTeX source; students see it typeset.
    mathText("p", { className: "question-prompt" }, question.prompt),
    el("span", {
      className: "question-points",
      text: `${points} ${points === 1 ? "mark" : "marks"}`,
    }),
  ]);

  let body;
  if (question.type === "text") {
    const input = el("input", { type: "text", placeholder: "Your answer" });
    input.addEventListener("input", () => {
      answers.set(question.id, input.value);
      updateAnsweredCount();
    });
    body = el("div", { className: "question-body" }, [input]);
  } else {
    const options = Array.isArray(question.options) ? question.options : [];
    body = el(
      "div",
      { className: "question-body" },
      options.map(option => choiceInput(question, option))
    );

    if (question.type === "multiple") {
      body.append(el("small", { className: "hint", text: "Select all that apply." }));
    }
  }

  return el("article", { className: "question-card" }, [header, body]);
}

function showResult({ score, total, percentage }) {
  formEl.hidden = true;
  resultEl.hidden = false;

  const passed = Number(percentage) >= 40;

  const panel = el("div", { className: `result-panel ${passed ? "result-pass" : "result-fail"}` }, [
    el("p", { className: "result-eyebrow", text: "Submitted" }),
    el("p", { className: "result-score", text: `${score} / ${total}` }),
    el("p", { className: "result-percent", text: `${percentage}%` }),
    el("p", {
      className: "sub",
      text: "Your teacher can see this result now. It is also on your dashboard.",
    }),
  ]);

  resultEl.replaceChildren(panel);
  celebrate(panel);
  closeSeb(panel);
}

/**
 * Ends the page on a message the student cannot act on.
 *
 * Inside Safe Exam Browser this MUST also close the browser. Quitting is
 * password-protected — that is the entire point of the lockdown — so a student
 * who reaches a dead end with no way out is genuinely stuck until a teacher
 * walks over and types the password. Relaunching a test they have already
 * submitted is the easiest way to land here, but every other dead end (no
 * questions, deadline passed, test deleted) traps them just the same.
 *
 * The quit URL is the only exit, so every terminal state routes through here.
 */
function deadEnd({ title, message, tone = "error", icon = "!", note, action }) {
  formEl.hidden = true;
  // The page's own Back button would be a second, quieter copy of the action
  // this panel already offers.
  backBtn.hidden = true;

  const panel = el("div", { className: `state-panel state-panel-${tone}` }, [
    el("div", { className: "state-icon", text: icon }),
    el("h2", { className: "state-title", text: title }),
    el("p", { className: "state-message", text: message }),
  ]);

  if (note) panel.append(el("small", { className: "hint", text: note }));

  if (isRunningInSeb()) {
    // No dashboard to send them to from inside the lockdown — the only useful
    // action is leaving, which closeSeb() does on a visible countdown.
    closeSeb(panel);
  } else if (action) {
    // Some dead ends have a better way forward than the dashboard.
    const actionBtn = el("button", { type: "button", className: "block", text: action.label });
    actionBtn.addEventListener("click", action.onClick);
    panel.append(actionBtn);
  } else {
    panel.append(
      el("p", {
        className: "state-hint",
        text:
          "Your dashboard may be showing an out-of-date list. Refresh it to see " +
          "what is actually available to you now.",
      })
    );

    const refreshBtn = el("button", {
      type: "button",
      className: "block",
      text: "Refresh dashboard",
    });
    // replace(), not assign(): this page should not sit in the back stack for
    // a student to walk into again.
    refreshBtn.addEventListener("click", () => location.replace("dashboard.html"));
    panel.append(refreshBtn);
  }

  stateEl.replaceChildren(panel);
}

/** Ends the exam without a score, e.g. when time ran out before submitting. */
function endWithNotice(message, tone = "error") {
  formEl.hidden = true;
  resultEl.hidden = false;

  const panel = el("div", { className: "result-panel result-fail" }, [
    el("p", { className: `notice notice-${tone}`, text: message }),
  ]);

  resultEl.replaceChildren(panel);
  closeSeb(panel);
}

/**
 * @param {boolean} auto True when the timer fired rather than the student.
 */
async function submit(auto = false) {
  if (submitted) return;

  if (!auto) {
    const unanswered = questions.length - Number(answeredEl.textContent.split(" ")[0]);
    if (unanswered > 0 && !confirm(`${unanswered} question(s) are unanswered. Submit anyway?`)) {
      return;
    }
  }

  // Set before the request, not after: a second click while it is in flight
  // would otherwise be graded as a duplicate attempt.
  submitted = true;
  stopTimer();

  const reset = setBusy(submitBtn, auto ? "Time up — submitting..." : "Submitting...");

  try {
    // Graded on the server: the browser never sees the answer key, and the
    // score it reports is the score that was stored.
    const { data, error } = await supabase.rpc("submit_exam", {
      p_test_id: testId,
      p_answers: Object.fromEntries(answers),
    });
    if (error) throw error;

    showResult(data);
    toast(auto ? "Time is up. Your test was submitted." : "Test submitted and graded.", "success");
  } catch (err) {
    console.error("Submit failed:", err);

    const message =
      err?.code === "PGRST202"
        ? "Tests are not set up yet. Run every migration in supabase/migrations/, newest included."
        : errorMessage(err, "Could not submit your test.");

    // An auto-submit has no one to retry it — the time it needed is gone — so
    // it ends the exam rather than handing back a button that cannot work.
    if (auto) {
      endWithNotice(message);
      return;
    }

    submitted = false;
    startTimer();
    toast(message, "error");
    reset();
  }
}

function renderClock() {
  if (endsAtMs === null) return;

  const left = endsAtMs - Date.now();
  clockValueEl.textContent = formatClock(left);

  // Colour is the warning a student actually notices; the toast below is for
  // anyone who has scrolled the header out of view.
  clockEl.classList.toggle("exam-clock-warn", left <= 5 * 60000 && left > 60000);
  clockEl.classList.toggle("exam-clock-danger", left <= 60000);

  if (left <= 0) {
    stopTimer();
    submit(true);
  }
}

function startTimer() {
  if (endsAtMs === null || submitted) return;

  stopTimer();
  clockEl.hidden = false;
  renderClock();
  timerId = setInterval(renderClock, 1000);
}

/**
 * Anchors the countdown to the server's clock.
 *
 * ends_at and server_time are read in the same statement on the server, so
 * their difference is the true time remaining however wrong the browser's
 * clock is.
 */
function armTimer({ ends_at: endsAt, server_time: serverTime }) {
  if (!endsAt) return;

  const end = Date.parse(endsAt);
  const server = Date.parse(serverTime);
  if (Number.isNaN(end) || Number.isNaN(server)) return;

  endsAtMs = Date.now() + (end - server);
  startTimer();

  const remaining = endsAtMs - Date.now();
  if (remaining > 60000) {
    toast(`You have ${formatClock(remaining)} to finish this test.`, "info");
  }
}

function describeTest(test) {
  titleEl.textContent = test.title;
  subjectEl.textContent = test.subject;
  document.title = `${test.title} · Exam Portal`;
}

/** Sub-heading under the title: length of the paper and its time limits. */
function describeMeta(test) {
  const parts = [];

  if (questions.length) {
    const marks = questions.reduce((sum, question) => sum + (Number(question.points) || 1), 0);
    parts.push(`${questions.length} question${questions.length === 1 ? "" : "s"} · ${marks} marks`);
  }
  if (test.duration_minutes) parts.push(formatDuration(test.duration_minutes));
  if (test.closes_at) parts.push(`Closes ${formatDateTime(test.closes_at)}`);

  metaEl.textContent = parts.join(" · ");
}

/**
 * States get_exam can return that end the page before any question loads.
 *
 * Each carries its own heading, because "why can I not take this test" has
 * several very different answers and a student needs to know which one they
 * are looking at — already done is reassuring, missed the deadline is not.
 */
const BLOCKED = {
  not_found: {
    icon: "?",
    title: "Test not found",
    message: "This test no longer exists. Your teacher may have removed it.",
  },
  not_released: {
    icon: "\u{1F512}",
    title: "Not released yet",
    message: "Your teacher has not released this test. It will appear when they do.",
  },
  not_assigned: {
    icon: "\u{1F512}",
    title: "Not assigned to you",
    message:
      "This test was set for a specific group of students, and you are not on the list. " +
      "Speak to your teacher if you think that is a mistake.",
  },
  already_attempted: {
    icon: "\u2713",
    tone: "done",
    title: "Already submitted",
    message: "You have completed this test. Your result is on your dashboard under My Results.",
  },
  closed: {
    icon: "\u23F1",
    title: "Deadline passed",
    message: "This test closed before it was submitted, so it can no longer be taken.",
  },
  not_open_yet: {
    icon: "\u{1F512}",
    title: "Not open yet",
    message: "This test has not reached its start time.",
  },
  time_up: {
    icon: "\u23F1",
    title: "Time ran out",
    message: "Your time for this test has run out, so it can no longer be submitted.",
  },
};

async function loadExam() {
  if (!testId) {
    deadEnd({
      icon: "?",
      title: "No test selected",
      message: "This page was opened without a test. Pick one from your dashboard.",
    });
    return;
  }

  setNotice(stateEl, "Loading test...");

  const { data, error } = await supabase.rpc("get_exam", {
    p_test_id: testId,
    // Whether this page can see SEB's own JavaScript API. Recorded against the
    // attempt rather than used to refuse: it is what tells a teacher that a
    // browser merely claiming to be SEB in its user agent was not really SEB.
    p_seb_api: typeof window.SafeExamBrowser !== "undefined",
  });

  if (error) {
    console.error("Could not load exam:", error.message);
    const notSetUp =
      error.code === "PGRST202" ||
      /could not find the function|does not exist/i.test(error.message);

    deadEnd({
      title: notSetUp ? "Tests are not set up" : "Could not load this test",
      message: notSetUp
        ? "Built-in tests are not set up yet. Run supabase/migrations/0008_exam_delivery.sql."
        : "Something went wrong loading this test. Please try again.",
    });
    return;
  }

  if (data?.test) describeTest(data.test);

  // Arriving early is not an error, it is a wait — so it gets the moment it
  // opens and a live countdown rather than a red notice.
  if (data?.state === "not_open_yet") {
    const opensAt = new Date(data.opens_at);

    // Anchored to the server's clock, like the exam timer: the countdown must
    // reach zero at the moment get_exam() will actually agree the test is
    // open, or the reload below lands on this same screen again.
    const skew = Date.parse(data.server_time) - Date.now();
    const waitMs = opensAt - skew - Date.now();

    // A locked-down browser is a poor waiting room — the student cannot quit
    // it without a teacher's password. A short wait is worth sitting through;
    // a long one means come back later, so SEB is closed.
    if (isRunningInSeb() && waitMs > SEB_WAIT_LIMIT_MS) {
      deadEnd({
        icon: "\u{1F512}",
        tone: "info",
        title: "Not open yet",
        message: `This test opens ${formatDateTime(data.opens_at)}. Launch it again then.`,
      });
      return;
    }

    const line = el("p", { className: "notice" });
    stateEl.replaceChildren(line);

    const tick = () => {
      const left = opensAt - skew - Date.now();
      if (left <= 0) {
        clearInterval(timer);
        line.textContent = "This test is open now. Reloading...";
        location.reload();
        return;
      }
      line.textContent = `This test opens ${formatDateTime(data.opens_at)} — in ${formatCountdown(left)}.`;
    };

    const timer = setInterval(tick, 1000);
    tick();
    return;
  }

  // A protected test opened in an ordinary browser. The database refused to
  // hand over the paper; rather than a dead end, send the student to the Safe
  // Exam Browser launcher they skipped.
  if (data?.state === "seb_required") {
    deadEnd({
      icon: "\u{1F512}",
      tone: "info",
      title: "Open this test in Safe Exam Browser",
      message:
        "This test is protected, so it can only be taken in Safe Exam Browser. " +
        "Opening its link in an ordinary browser will not start it.",
      // So a genuine SEB that is not being recognised can be diagnosed from a
      // screenshot rather than guessed at.
      note: data.user_agent ? `Browser seen: ${data.user_agent}` : undefined,
      action: {
        label: "Open in Safe Exam Browser",
        onClick: () => openSebGate({ ...data.test, seb_config_url: data.seb_config_url }),
      },
    });
    return;
  }

  const blocked = BLOCKED[data?.state];
  if (blocked) {
    deadEnd(blocked);
    return;
  }

  // A link test lives on Google Forms or similar; this page only forwards to it.
  if (data.state === "external") {
    setNotice(stateEl, "Opening your test...");
    if (data.form_url) location.replace(data.form_url);
    else
      deadEnd({
        title: "This test has no link",
        message: "Your teacher has not added the link for this test yet. Please tell them.",
      });
    return;
  }

  questions = data.questions ?? [];

  if (!questions.length) {
    deadEnd({
      icon: "\u{1F4DD}",
      tone: "info",
      title: "No questions yet",
      message: "Your teacher has not added any questions to this test yet.",
    });
    return;
  }

  describeMeta(data.test);
  stateEl.replaceChildren();

  // An admin opening a draft sees the paper exactly as a student would, but
  // with no clock and no way to submit — previewing must not create a result.
  if (data.state === "preview") {
    setNotice(stateEl, "Preview of a draft. Students cannot open this test yet.", "info");
    submitBtn.disabled = true;
    submitBtn.textContent = "Preview only";
  }

  listEl.replaceChildren(...questions.map(questionCard));
  formEl.hidden = false;
  updateAnsweredCount();

  if (data.state === "open") armTimer(data);
}

submitBtn.addEventListener("click", () => submit(false));
await loadExam();
