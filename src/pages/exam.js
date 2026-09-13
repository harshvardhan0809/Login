import { supabase } from "../lib/supabase.js";
import { requireUser } from "../lib/session.js";
import { el, errorMessage, setBusy, setNotice, toast } from "../lib/ui.js";
import { formatClock, formatDateTime, formatDuration } from "../lib/dates.js";
import { isRunningInSeb, sebQuitUrl } from "../lib/seb.js";
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
 * Inside SEB, close the browser shortly after submitting.
 *
 * Navigating to the config's quitURL is what actually quits SEB; the delay
 * only exists so the student can read their score first. Outside SEB there is
 * nothing to close, so the Back button stands in for it.
 *
 * The countdown is shown, not just waited out. A locked-down browser closing
 * itself with no warning reads as a crash — which is exactly the wrong thing
 * to feel in the ten seconds after finishing an exam.
 */
function closeAfterSubmit(container) {
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
  closeAfterSubmit(panel);
}

/** Ends the exam without a score, e.g. when time ran out before submitting. */
function endWithNotice(message, tone = "error") {
  formEl.hidden = true;
  resultEl.hidden = false;

  const panel = el("div", { className: "result-panel result-fail" }, [
    el("p", { className: `notice notice-${tone}`, text: message }),
  ]);

  resultEl.replaceChildren(panel);
  closeAfterSubmit(panel);
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
        ? "Built-in tests are not set up yet. Run supabase/migrations/0008_exam_delivery.sql."
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

/** States get_exam can return that end the page before any question loads. */
const BLOCKED = {
  not_found: "That test no longer exists.",
  not_released: "Your teacher has not released this test yet.",
  already_attempted: "You have already submitted this test. Your result is on your dashboard.",
  closed: "The deadline for this test has passed.",
  time_up: "Your time for this test has run out.",
};

async function loadExam() {
  if (!testId) {
    setNotice(stateEl, "No test was specified.", "error");
    return;
  }

  setNotice(stateEl, "Loading test...");

  const { data, error } = await supabase.rpc("get_exam", { p_test_id: testId });

  if (error) {
    console.error("Could not load exam:", error.message);
    const notSetUp =
      error.code === "PGRST202" ||
      /could not find the function|does not exist/i.test(error.message);

    setNotice(
      stateEl,
      notSetUp
        ? "Built-in tests are not set up yet. Run supabase/migrations/0008_exam_delivery.sql."
        : "Could not load this test. Please go back and try again.",
      "error"
    );
    return;
  }

  if (data?.test) describeTest(data.test);

  const blocked = BLOCKED[data?.state];
  if (blocked) {
    setNotice(stateEl, blocked, data.state === "already_attempted" ? "info" : "error");
    return;
  }

  // A link test lives on Google Forms or similar; this page only forwards to it.
  if (data.state === "external") {
    setNotice(stateEl, "Opening your test...");
    if (data.form_url) location.replace(data.form_url);
    else setNotice(stateEl, "This test has no link set. Please tell your teacher.", "error");
    return;
  }

  questions = data.questions ?? [];

  if (!questions.length) {
    setNotice(stateEl, "Your teacher has not added any questions to this test yet.");
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
