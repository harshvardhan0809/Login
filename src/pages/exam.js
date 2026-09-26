import { supabase } from "../lib/supabase.js";
import { displayName, requireUser } from "../lib/session.js";
import { el, errorMessage, setBusy, setNotice, toast } from "../lib/ui.js";
import { formatClock, formatCountdown, formatDateTime, formatDuration } from "../lib/dates.js";
import { isRunningInSeb, sebQuitUrl } from "../lib/seb.js";
import { openSebGate } from "../lib/sebGate.js";
import { celebrate } from "../lib/celebrate.js";
import { mathText, setMathText } from "../lib/math.js";
import { penaltyFor, penaltyLabel } from "../lib/marking.js";

const subjectEl = document.getElementById("examSubject");
const titleEl = document.getElementById("examTitle");
const metaEl = document.getElementById("examMeta");
const candidateEl = document.getElementById("candidate");
const stateEl = document.getElementById("examState");
const formEl = document.getElementById("examForm");
const resultEl = document.getElementById("examResult");
const backBtn = document.getElementById("backBtn");
const clockEl = document.getElementById("examClock");
const clockValueEl = document.getElementById("examClockValue");
const warningEl = document.getElementById("timeWarning");

const qNumberEl = document.getElementById("qNumber");
const qSectionEl = document.getElementById("qSection");
const qTypeEl = document.getElementById("qType");
const qMarksEl = document.getElementById("qMarks");
const qBodyEl = document.getElementById("qBody");
const paletteEl = document.getElementById("palette");
const paletteGridEl = document.getElementById("paletteGrid");
const legendEl = document.getElementById("legend");
const paletteToggle = document.getElementById("paletteToggle");
const paletteClose = document.getElementById("paletteClose");
const paletteScrim = document.getElementById("paletteScrim");

const saveNextBtn = document.getElementById("saveNextBtn");
const markBtn = document.getElementById("markBtn");
const clearBtn = document.getElementById("clearBtn");
const prevBtn = document.getElementById("prevBtn");
const submitBtn = document.getElementById("submitBtn");

/** Seconds SEB stays open after a submission, so the student sees their score. */
const CLOSE_DELAY_SECONDS = 10;

/**
 * How long a student may wait inside SEB for a test to open.
 *
 * Past this it is kinder to close the browser and let them relaunch than to
 * hold them in a session they cannot leave.
 */
const SEB_WAIT_LIMIT_MS = 2 * 60 * 1000;

/** Time-left marks at which the student is warned, loudest last. */
const WARNINGS = [
  { ms: 10 * 60000, text: "10 minutes left." },
  { ms: 5 * 60000, text: "5 minutes left." },
  { ms: 60000, text: "1 minute left. The test will be submitted automatically at 00:00." },
];

const TYPE_LABELS = {
  single: "Single correct",
  multiple: "Multiple correct",
  numerical: "Numerical value",
  text: "Short answer",
};

/**
 * Palette states, in legend order.
 *
 * The colours follow the convention students already know from computer-based
 * exams, so nobody has to learn what a green square means on the day.
 */
const STATUSES = [
  { key: "answered", label: "Answered" },
  { key: "not-answered", label: "Not Answered" },
  { key: "not-visited", label: "Not Visited" },
  { key: "marked", label: "Marked for Review" },
  { key: "answered-marked", label: "Answered & Marked for Review (will be evaluated)" },
];

backBtn.addEventListener("click", () => location.replace("dashboard.html"));

/**
 * The Back to Dashboard button, which never appears inside Safe Exam Browser.
 *
 * In SEB the dashboard is a trap: the student lands on a page with no exam and
 * no way to quit, because quitting needs the teacher's password. The only
 * exit there is the quit URL that closeSeb() navigates to. The button starts
 * hidden in the HTML so it cannot flash up while the page is loading.
 */
function showBack(show) {
  backBtn.hidden = !show || isRunningInSeb();
}

const user = await requireUser();
candidateEl.textContent = displayName(user);

const testId = new URLSearchParams(location.search).get("test");

/** Where an unfinished paper is kept, so a reload or crash loses nothing. */
const STORAGE_KEY = `cbt:${testId}:${user.id}`;

/** Answers keyed by question id: string[] for choices, string for typed ones. */
const answers = new Map();
const visited = new Set();
const marked = new Set();
let questions = [];
let current = 0;
let submitted = false;
let preview = false;
let timerId = null;

/**
 * When this exam ends, in *browser* milliseconds.
 *
 * The value comes from the server and is corrected for the difference between
 * the two clocks, so a student who puts their laptop's clock back an hour
 * gains nothing. null means the test is untimed.
 */
let endsAtMs = null;

/** Fraction of a question's marks lost for a wrong answer; 0 for none. */
let negativeMarking = 0;
const warned = new Set();

/** Closes the submit confirmation if it is open; set while it is. */
let closeConfirm = null;

// --- saving progress locally ----------------------------------------------

/**
 * Keeps the paper in this browser until it is submitted.
 *
 * SEB can crash and laptops run out of battery; the server keeps the clock
 * running regardless, so reopening the test must bring the answers back too.
 * Storage can be unavailable (private windows, locked-down profiles), in which
 * case the paper simply works without it.
 */
function persist() {
  if (preview) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        answers: Object.fromEntries(answers),
        visited: [...visited],
        marked: [...marked],
        current,
      })
    );
  } catch {
    // Not fatal: the answers are still on screen.
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved) return;

    // Only ids that are still on the paper: a question deleted since must not
    // be sent back as an answer.
    const ids = new Set(questions.map(question => question.id));
    for (const [id, value] of Object.entries(saved.answers ?? {})) {
      if (ids.has(id)) answers.set(id, value);
    }
    for (const id of saved.visited ?? []) if (ids.has(id)) visited.add(id);
    for (const id of saved.marked ?? []) if (ids.has(id)) marked.add(id);

    const index = Number(saved.current);
    if (Number.isInteger(index) && index >= 0 && index < questions.length) current = index;
  } catch {
    // Corrupt or unavailable storage: start clean.
  }
}

function forget() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up.
  }
}

// --- question state -------------------------------------------------------

function hasAnswer(question) {
  const value = answers.get(question.id);
  return Array.isArray(value) ? value.length > 0 : Boolean(String(value ?? "").trim());
}

function statusOf(question) {
  const answered = hasAnswer(question);
  if (marked.has(question.id)) return answered ? "answered-marked" : "marked";
  if (answered) return "answered";
  return visited.has(question.id) ? "not-answered" : "not-visited";
}

function statusCounts() {
  const counts = Object.fromEntries(STATUSES.map(status => [status.key, 0]));
  for (const question of questions) counts[statusOf(question)] += 1;
  return counts;
}

// --- palette --------------------------------------------------------------

function swatch(key, count) {
  return el("span", { className: `cbt-swatch st-${key}`, text: String(count) });
}

function renderLegend() {
  const counts = statusCounts();
  legendEl.replaceChildren(
    ...STATUSES.map(status =>
      el("li", { className: "cbt-legend-item" }, [
        swatch(status.key, counts[status.key]),
        el("span", { text: status.label }),
      ])
    )
  );
}

/**
 * How a question is numbered: 1, 2, 3 on the main paper, B1, B2 in the bonus
 * section. The server sends bonus questions last, so counting in order works.
 */
function numberOf(index) {
  const question = questions[index];
  const sameSection = questions
    .slice(0, index + 1)
    .filter(other => Boolean(other.bonus) === Boolean(question.bonus)).length;
  return question.bonus ? `B${sameSection}` : String(sameSection);
}

function nameOf(index) {
  return questions[index].bonus
    ? `Bonus question ${numberOf(index).slice(1)}`
    : `Question ${numberOf(index)}`;
}

function paletteCell(question, index) {
  const status = statusOf(question);
  const label = STATUSES.find(item => item.key === status).label;
  const button = el("button", {
    type: "button",
    className: `cbt-cell st-${status}${index === current ? " is-current" : ""}`,
    text: numberOf(index),
    title: `${nameOf(index)}: ${label}`,
  });
  button.setAttribute("role", "listitem");
  button.setAttribute("aria-label", `${nameOf(index)}, ${label}`);
  if (index === current) button.setAttribute("aria-current", "true");

  button.addEventListener("click", () => {
    goTo(index);
    setPaletteOpen(false);
  });
  return button;
}

/** The heading a question sits under in the palette, or "" for none. */
function sectionOf(question) {
  if (question.bonus) return "Bonus section";
  return question.section ?? "";
}

function renderPalette() {
  const cells = [];
  let heading = null;

  questions.forEach((question, index) => {
    const section = sectionOf(question);
    // A heading spans the grid wherever the section changes, so each part of
    // the paper is clearly its own.
    if (section && section !== heading) {
      cells.push(el("p", { className: "cbt-grid-heading", text: section }));
    }
    heading = section;
    cells.push(paletteCell(question, index));
  });

  paletteGridEl.replaceChildren(...cells);
  renderLegend();
}

/** On narrow screens the palette is a drawer; on wide ones it is always shown. */
function setPaletteOpen(open) {
  paletteEl.classList.toggle("is-open", open);
  paletteScrim.hidden = !open;
  paletteToggle.setAttribute("aria-expanded", String(open));
}

paletteToggle.addEventListener("click", () =>
  setPaletteOpen(!paletteEl.classList.contains("is-open"))
);
paletteClose.addEventListener("click", () => setPaletteOpen(false));
paletteScrim.addEventListener("click", () => setPaletteOpen(false));

// --- the current question -------------------------------------------------

function recordAnswer(question, value) {
  if (Array.isArray(value) ? value.length : String(value).trim()) {
    answers.set(question.id, value);
  } else {
    answers.delete(question.id);
  }
  persist();
  renderPalette();
}

const LETTERS = "ABCDEFGHIJ";

function choiceList(question) {
  const multiple = question.type === "multiple";
  const options = Array.isArray(question.options) ? question.options : [];
  const chosen = new Set(answers.get(question.id) ?? []);

  const list = el("div", { className: "cbt-options" });
  list.setAttribute("role", multiple ? "group" : "radiogroup");

  options.forEach((option, index) => {
    const input = el("input", {
      type: multiple ? "checkbox" : "radio",
      name: `q-${question.id}`,
      value: option.id,
      checked: chosen.has(option.id),
      className: "cbt-option-input",
    });

    input.addEventListener("change", () => {
      if (multiple) {
        const next = new Set(answers.get(question.id) ?? []);
        input.checked ? next.add(option.id) : next.delete(option.id);
        recordAnswer(question, [...next]);
      } else {
        // One option only: a radio group cannot hold two.
        recordAnswer(question, [option.id]);
      }
    });

    list.append(
      el("label", { className: "cbt-option" }, [
        input,
        el("span", { className: "cbt-option-letter", text: LETTERS[index] ?? String(index + 1) }),
        setMathText(el("span", { className: "cbt-option-text" }), option.text),
      ])
    );
  });

  return list;
}

/** Keeps a numerical answer to what can be graded: digits, one point, a leading sign. */
function cleanNumber(raw) {
  let text = raw.replace(/[^0-9.+-]/g, "");
  const sign = /^[+-]/.test(text) ? text[0] : "";
  text = text.replace(/[+-]/g, "");
  const dot = text.indexOf(".");
  if (dot !== -1) text = text.slice(0, dot + 1) + text.slice(dot + 1).replace(/\./g, "");
  return (sign + text).slice(0, 20);
}

/**
 * The numerical answer box, with an on-screen keypad.
 *
 * The keypad is there for tablets, where Safe Exam Browser may not raise a
 * numeric keyboard; the box still takes typing on a laptop.
 */
function numericalInput(question) {
  const input = el("input", {
    type: "text",
    inputMode: "decimal",
    autocomplete: "off",
    spellcheck: false,
    className: "cbt-answer-box",
    placeholder: "Enter your answer",
    value: answers.get(question.id) ?? "",
  });
  input.setAttribute("aria-label", "Numerical answer");

  const commit = () => {
    const cleaned = cleanNumber(input.value);
    if (cleaned !== input.value) input.value = cleaned;
    recordAnswer(question, cleaned);
  };
  input.addEventListener("input", commit);

  const press = key => {
    if (key === "-") {
      input.value = input.value.startsWith("-") ? input.value.slice(1) : `-${input.value}`;
    } else if (key === "⌫") {
      input.value = input.value.slice(0, -1);
    } else {
      input.value += key;
    }
    commit();
  };

  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", ".", "-", "⌫"];
  const pad = el(
    "div",
    { className: "cbt-keypad" },
    keys.map(key => {
      const button = el("button", {
        type: "button",
        className: key === "⌫" ? "cbt-key cbt-key-wide" : "cbt-key",
        text: key === "⌫" ? "Backspace" : key === "-" ? "− / +" : key,
      });
      button.addEventListener("click", () => press(key));
      return button;
    })
  );

  return el("div", { className: "cbt-numeric" }, [
    el("p", { className: "cbt-numeric-label", text: "Your answer (numerical value)" }),
    input,
    pad,
  ]);
}

function textInput(question) {
  const input = el("input", {
    type: "text",
    autocomplete: "off",
    className: "cbt-answer-box",
    placeholder: "Type your answer",
    value: answers.get(question.id) ?? "",
  });
  input.setAttribute("aria-label", "Your answer");
  input.addEventListener("input", () => recordAnswer(question, input.value));
  return input;
}

function renderQuestion() {
  const question = questions[current];
  if (!question) return;

  visited.add(question.id);

  const points = Number(question.points) || 0;
  const inSection = questions.filter(other => Boolean(other.bonus) === Boolean(question.bonus));
  qNumberEl.textContent = question.bonus
    ? `Bonus question ${numberOf(current).slice(1)} of ${inSection.length}`
    : `Question ${numberOf(current)} of ${inSection.length}`;
  qTypeEl.textContent = TYPE_LABELS[question.type] ?? "Question";

  // "4 marks · −1 if wrong" is how a candidate thinks about a question.
  const lost =
    question.bonus || question.type === "text" ? null : penaltyFor(points, negativeMarking);
  qMarksEl.textContent = question.bonus
    ? points
      ? `Bonus · +${points} ${points === 1 ? "mark" : "marks"}`
      : "Bonus · no marks"
    : `${points} ${points === 1 ? "mark" : "marks"}${lost ? ` · ${lost} if wrong` : ""}`;
  qMarksEl.classList.toggle("cbt-chip-bonus", Boolean(question.bonus));

  // The section a student is in, beside the question number.
  const section = question.bonus ? null : question.section;
  qSectionEl.textContent = section ?? "";
  qSectionEl.hidden = !section;

  const body = [
    el("p", { className: "cbt-qlabel", text: nameOf(current) }),
    // Stored as LaTeX source; students see it typeset.
    mathText("div", { className: "cbt-prompt" }, question.prompt),
  ];

  if (question.type === "numerical") body.push(numericalInput(question));
  else if (question.type === "text") body.push(textInput(question));
  else {
    body.push(choiceList(question));
    if (question.type === "multiple") {
      body.push(el("p", { className: "cbt-hint", text: "One or more options may be correct." }));
    }
  }

  qBodyEl.replaceChildren(...body);

  prevBtn.disabled = current === 0;
  const last = current === questions.length - 1;
  saveNextBtn.textContent = last ? "Save" : "Save & Next";
  markBtn.textContent = last ? "Mark for Review" : "Mark for Review & Next";

  persist();
  renderPalette();

  // On a phone the page scrolls; bring the new question's top into view.
  if (qNumberEl.getBoundingClientRect().top < 0) qNumberEl.scrollIntoView({ block: "start" });
}

function goTo(index) {
  if (index < 0 || index >= questions.length) return;
  current = index;
  renderQuestion();
}

function next() {
  if (current < questions.length - 1) {
    goTo(current + 1);
  } else {
    renderQuestion();
    toast("That was the last question. Review from the palette, or submit when you are ready.");
  }
}

// Answers are recorded as they are chosen, so nothing is lost if the timer
// runs out between choosing and pressing a button. The buttons decide the
// review mark and where to go next.
saveNextBtn.addEventListener("click", () => {
  marked.delete(questions[current].id);
  next();
});

markBtn.addEventListener("click", () => {
  marked.add(questions[current].id);
  next();
});

clearBtn.addEventListener("click", () => {
  answers.delete(questions[current].id);
  renderQuestion();
});

prevBtn.addEventListener("click", () => goTo(current - 1));

// --- leaving and closing --------------------------------------------------

/**
 * Inside SEB, close the browser after a short, visible countdown.
 *
 * Navigating to the config's quitURL is what actually quits SEB; the delay
 * only exists so the student can read the screen first. Outside SEB there is
 * nothing to close, so the Back button stands in for it.
 */
function closeSeb(container) {
  if (!isRunningInSeb()) return;

  const count = el("span", { className: "close-count", text: String(CLOSE_DELAY_SECONDS) });

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

/** Warns before the tab is closed or reloaded mid-exam. */
function guardUnload(event) {
  if (submitted || preview) return;
  event.preventDefault();
  event.returnValue = "";
}

function endPaper() {
  formEl.hidden = true;
  warningEl.hidden = true;
  setPaletteOpen(false);
  window.removeEventListener("beforeunload", guardUnload);
}

function showResult({ score, total, percentage }) {
  endPaper();
  resultEl.hidden = false;
  clockEl.hidden = true;
  showBack(true);

  const panel = el("div", { className: "result-panel" }, [
    el("p", { className: "result-eyebrow", text: "Test submitted" }),
    el("p", { className: "result-score", text: `${score} / ${total}` }),
    el("p", { className: "result-percent", text: `${percentage}%` }),
    el("p", {
      className: "sub",
      text: "Your responses have been recorded. This result is also on your dashboard.",
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
 * password-protected, so a student who reaches a dead end with no way out is
 * genuinely stuck until a teacher walks over and types the password. The quit
 * URL is the only exit, so every terminal state routes through here.
 */
function deadEnd({ title, message, tone = "error", icon = "!", note, action }) {
  endPaper();
  showBack(false);

  const panel = el("div", { className: `state-panel state-panel-${tone}` }, [
    el("div", { className: "state-icon", text: icon }),
    el("h2", { className: "state-title", text: title }),
    el("p", { className: "state-message", text: message }),
  ]);

  if (note) panel.append(el("small", { className: "hint", text: note }));

  if (isRunningInSeb()) {
    closeSeb(panel);
  } else if (action) {
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
    // replace(), not assign(): this page should not sit in the back stack.
    refreshBtn.addEventListener("click", () => location.replace("dashboard.html"));
    panel.append(refreshBtn);
  }

  stateEl.replaceChildren(panel);
}

/** Ends the exam without a score, e.g. when time ran out before submitting. */
function endWithNotice(message) {
  endPaper();
  resultEl.hidden = false;
  showBack(true);

  const panel = el("div", { className: "result-panel" }, [
    el("p", { className: "notice notice-error", text: message }),
  ]);

  resultEl.replaceChildren(panel);
  closeSeb(panel);
}

// --- submitting -----------------------------------------------------------

/**
 * Asks before submitting, showing where every question stands.
 *
 * "Go back" is focused and is what Escape and a click outside choose, so the
 * only way to submit is to press the submit button on purpose.
 */
function confirmSubmit() {
  return new Promise(resolve => {
    const counts = statusCounts();
    const answered = counts.answered + counts["answered-marked"];
    const left = questions.length - answered;

    const rows = STATUSES.map(status =>
      el("tr", {}, [
        el("td", {}, [swatch(status.key, counts[status.key])]),
        el("td", { text: status.label }),
      ])
    );

    const cancelBtn = el("button", {
      type: "button",
      className: "cbt-btn cbt-btn-plain",
      text: "Go back to test",
    });
    const confirmBtn = el("button", {
      type: "button",
      className: "cbt-btn cbt-btn-submit",
      text: "Yes, submit test",
    });

    const dialog = el("div", { className: "modal cbt-dialog" }, [
      el("h2", { className: "modal-title", text: "Submit your test?" }),
      el("table", { className: "cbt-summary" }, [el("tbody", {}, rows)]),
      el("p", {
        className: left ? "cbt-dialog-warn" : "cbt-dialog-note",
        text: left
          ? `${left} of ${questions.length} question${left === 1 ? " has" : "s have"} no answer.`
          : `All ${questions.length} questions have an answer.`,
      }),
      el("p", {
        className: "cbt-dialog-note",
        text: "Once submitted, you cannot change your answers or return to this test.",
      }),
      el("div", { className: "modal-actions" }, [cancelBtn, confirmBtn]),
    ]);
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Submit your test?");

    const backdrop = el("div", { className: "modal-backdrop" }, [dialog]);

    const close = value => {
      if (!closeConfirm) return;
      closeConfirm = null;
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    };
    closeConfirm = () => close(false);

    function onKey(event) {
      if (event.key === "Escape") close(false);
    }

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", event => {
      if (event.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKey);

    document.body.append(backdrop);
    cancelBtn.focus();
  });
}

const NAV_BUTTONS = [saveNextBtn, markBtn, clearBtn, prevBtn];

/**
 * @param {boolean} auto True when the timer fired rather than the student.
 */
async function submit(auto = false) {
  if (submitted || preview) return;

  if (!auto) {
    const sure = await confirmSubmit();
    // The clock may have run out while the dialog was open, and submitted.
    if (!sure || submitted) return;
  } else {
    closeConfirm?.();
  }

  // Set before the request, not after: a second click while it is in flight
  // would otherwise be graded as a duplicate attempt.
  submitted = true;
  stopTimer();

  const reset = setBusy(submitBtn, auto ? "Time up — submitting..." : "Submitting...");
  for (const button of NAV_BUTTONS) button.disabled = true;

  try {
    // Graded on the server: the browser never sees the answer key, and the
    // score it reports is the score that was stored.
    const { data, error } = await supabase.rpc("submit_exam", {
      p_test_id: testId,
      p_answers: Object.fromEntries(answers),
    });
    if (error) throw error;

    forget();
    showResult(data);
    toast(auto ? "Time is up. Your test was submitted." : "Test submitted.", "success");
  } catch (err) {
    console.error("Submit failed:", err);

    const message =
      err?.code === "PGRST202"
        ? "Tests are not set up yet. Run every migration in supabase/migrations/, newest included."
        : errorMessage(err, "Could not submit your test.");

    // An auto-submit has no one to retry it — the time it needed is gone.
    if (auto) {
      endWithNotice(message);
      return;
    }

    submitted = false;
    startTimer();
    toast(message, "error");
    reset();
    for (const button of NAV_BUTTONS) button.disabled = false;
    prevBtn.disabled = current === 0;
  }
}

submitBtn.addEventListener("click", () => submit(false));

// --- the clock ------------------------------------------------------------

function stopTimer() {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

let warningTimer = null;

function showWarning(text, urgent) {
  warningEl.textContent = text;
  warningEl.classList.toggle("is-urgent", urgent);
  warningEl.hidden = false;

  clearTimeout(warningTimer);
  // The last-minute warning stays up; the earlier ones get out of the way.
  if (!urgent) warningTimer = setTimeout(() => (warningEl.hidden = true), 12000);
}

function renderClock() {
  if (endsAtMs === null) return;

  const left = endsAtMs - Date.now();
  clockValueEl.textContent = formatClock(left);

  clockEl.classList.toggle("is-warn", left <= 5 * 60000 && left > 60000);
  clockEl.classList.toggle("is-danger", left <= 60000);

  for (const warning of WARNINGS) {
    if (left <= warning.ms && left > 0 && !warned.has(warning.ms)) {
      warned.add(warning.ms);
      showWarning(warning.text, warning.ms <= 60000);
    }
  }

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

  // Reopening with four minutes left should say so once, not replay the
  // ten- and five-minute warnings in a burst.
  const remaining = endsAtMs - Date.now();
  const due = WARNINGS.filter(warning => remaining <= warning.ms);
  for (const warning of due) warned.add(warning.ms);
  if (due.length && remaining > 0) {
    showWarning(
      `${formatClock(remaining)} left. The test will be submitted automatically at 00:00.`,
      due[due.length - 1].ms <= 60000
    );
  }

  startTimer();
}

// --- loading --------------------------------------------------------------

function describeTest(test) {
  titleEl.textContent = test.title;
  subjectEl.textContent = test.subject;
  document.title = `${test.title} · Exam Portal`;
}

function describeMeta(test) {
  const parts = [];

  // Bonus questions are counted apart: they add nothing to the total.
  const main = questions.filter(question => !question.bonus);
  const bonus = questions.length - main.length;
  if (main.length) {
    const marks = main.reduce((sum, question) => sum + (Number(question.points) || 0), 0);
    parts.push(`${main.length} question${main.length === 1 ? "" : "s"} · ${marks} marks`);
  }
  if (bonus) parts.push(`${bonus} bonus`);
  const penalty = penaltyLabel(test.negative_marking);
  if (penalty) parts.push(`wrong answers lose ${penalty}`);
  if (test.duration_minutes) parts.push(formatDuration(test.duration_minutes));
  if (test.closes_at) parts.push(`Closes ${formatDateTime(test.closes_at)}`);

  metaEl.textContent = parts.join(" · ");
}

/**
 * States get_exam can return that end the page before any question loads.
 *
 * Each carries its own heading, because "why can I not take this test" has
 * several very different answers.
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
    icon: "✓",
    tone: "done",
    title: "Already submitted",
    message: "You have completed this test. Your result is on your dashboard under My Results.",
  },
  closed: {
    icon: "⏱",
    title: "Deadline passed",
    message: "This test closed before it was submitted, so it can no longer be taken.",
  },
  not_open_yet: {
    icon: "\u{1F512}",
    title: "Not open yet",
    message: "This test has not reached its start time.",
  },
  time_up: {
    icon: "⏱",
    title: "Time ran out",
    message: "Your time for this test has run out, so it can no longer be submitted.",
  },
};

/**
 * The teacher's Safe Exam Browser verification panel.
 *
 * Run this before switching a test to strict: it says whether this SEB proved
 * itself with the key saved on the test. seb_check() is teachers-only, so for
 * a student the call fails and nothing is shown.
 *
 * Rendered as its own panel appended to the page rather than into the exam
 * body, so it survives whichever state the test ends up in — including the
 * "could not be verified" dead end, which is exactly when it is needed.
 */
async function showSebVerification(id) {
  const { data, error } = await supabase.rpc("seb_check", { p_test_id: id });
  if (error || !data) return;

  // Either road proves it: the digests attached to the database request, or
  // the ones this browser showed api/seb-verify. Windows has only the second,
  // so judging on the first alone reported failure on a working machine.
  const proof = data.proof_recorded === true;
  const learned = Boolean(data.proof_fingerprint_stored);
  const ok = data.verified === true || (proof && learned);

  // Logged in full when something is off, so it can be diagnosed from the
  // console rather than guessed at.
  if (!ok) console.warn("SEB check:", data);

  const panel = el("aside", { className: `seb-verify ${ok ? "is-ok" : "is-bad"}` }, [
    el("h2", { text: ok ? "SEB verified" : "SEB not verified" }),
    el("p", {
      text: !proof
        ? "This Safe Exam Browser did not show its verification keys, so students cannot " +
          "be checked automatically. Make sure the test was launched from the portal " +
          "rather than typed in, and that its config is current."
        : learned
          ? "This test now recognises your Safe Exam Browser. Students must match it " +
            "to open the paper — there is nothing further to set up."
          : "Keys arrived, but no fingerprint has been stored yet. Reload this page " +
            "inside SEB to record it.",
    }),
    el(
      "ul",
      {},
      [
        `Keys shown to this site: ${proof ? "yes" : "no"}`,
        `Fingerprint stored: ${learned ? "yes" : "no"}`,
        `Enforcement: ${data.enforcement ?? "auto"}`,
      ].map(text => el("li", { text }))
    ),
  ]);

  const dismiss = el("button", { type: "button", className: "secondary", text: "Dismiss" });
  dismiss.addEventListener("click", () => panel.remove());
  panel.append(dismiss);
  document.body.append(panel);
}

/**
 * Lets Safe Exam Browser prove itself where it actually sends its keys.
 *
 * SEB attaches its exam keys to requests for the portal's own domain. The
 * Windows build sends them nowhere else, so the database — on another domain —
 * never saw them and every student on Windows was refused. This call is
 * same-origin, so every SEB attaches its keys to it, and the endpoint records
 * what it saw for get_exam() to check a moment later.
 *
 * Deliberately never fatal. If the endpoint is missing or failing, the paper
 * still loads and get_exam() decides on whatever other evidence there is —
 * a diagnostic step must not be the reason a student cannot sit an exam.
 */
async function proveSeb() {
  if (!isRunningInSeb() || !testId) return;

  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return;

    const result = await fetch("/api/seb-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ testId }),
    });

    const report = await result.json();
    if (!report?.recorded) console.warn("SEB proof not recorded:", report);
  } catch (error) {
    console.warn("SEB proof step skipped:", error?.message);
  }
}

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

  // Must happen before get_exam, which is what reads the recording.
  await proveSeb();

  const { data, error } = await supabase.rpc("get_exam", {
    p_test_id: testId,
    // Recorded for the record only: genuine SEB attempts arrive without the
    // API, so it flags nothing.
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
        ? "Built-in tests are not set up yet. Run every migration in supabase/migrations/."
        : "Something went wrong loading this test. Please try again.",
    });
    return;
  }

  // Teachers only, and only inside SEB: the check to run before going strict.
  if (isRunningInSeb()) showSebVerification(testId);

  if (data?.test) describeTest(data.test);

  // Arriving early is a wait, not an error: a live countdown, then a reload.
  if (data?.state === "not_open_yet") {
    const opensAt = new Date(data.opens_at);

    // Anchored to the server's clock, so the reload lands when get_exam()
    // agrees the test is open.
    const skew = Date.parse(data.server_time) - Date.now();
    const waitMs = opensAt - skew - Date.now();

    // A locked-down browser is a poor waiting room for a long wait.
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
    // Outside SEB a student waiting early may leave; inside, showBack() refuses.
    showBack(true);

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

  // A protected test that would not open. Three different reasons, and telling
  // them apart matters: a student already sitting in a genuine SEB must not be
  // told to "open it in SEB", or they will simply try again and fail again.
  if (data?.state === "seb_required") {
    const REASONS = {
      key_mismatch: {
        title: "Safe Exam Browser could not be verified",
        message:
          "This copy of Safe Exam Browser did not prove it is genuine, so the test cannot " +
          "start. Quit it, launch the test again from the portal, and if it still fails, " +
          "tell your teacher — the exam key may need updating.",
      },
      key_not_configured: {
        title: "This test is not ready yet",
        message:
          "It is set to verify Safe Exam Browser, but no exam key has been saved for it, " +
          "so nobody can start it. Please tell your teacher.",
      },
    };
    const reason = REASONS[data.reason];

    deadEnd({
      icon: "\u{1F512}",
      tone: "info",
      title: reason?.title ?? "Open this test in Safe Exam Browser",
      message:
        reason?.message ??
        "This test is protected, so it can only be taken in Safe Exam Browser. " +
          "Opening its link in an ordinary browser will not start it.",
      note: data.user_agent ? `Browser seen: ${data.user_agent}` : undefined,
      // Relaunching cannot help when the test has no key at all.
      action:
        data.reason === "key_not_configured"
          ? undefined
          : {
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

  negativeMarking = Number(data.test?.negative_marking) || 0;
  describeMeta(data.test);
  stateEl.replaceChildren();

  // A teacher sees the paper exactly as a student would, but with no clock and
  // no way to submit — looking at a test must never leave a mark behind, which
  // is also what makes it safe to open one just to teach it an SEB fingerprint.
  preview = data.state === "preview";
  if (preview) {
    setNotice(stateEl, "Teacher preview. Nothing here is timed or recorded.", "info");
    submitBtn.disabled = true;
    submitBtn.textContent = "Preview only";

    // A preview has nothing to submit, and showBack() hides the Back button
    // inside SEB, so without this a teacher checking a paper — or teaching it
    // an SEB fingerprint — is trapped until someone types the quit password.
    // Navigating to the quit URL is what makes SEB close.
    if (isRunningInSeb()) {
      const leave = el("button", {
        type: "button",
        className: "secondary leave-seb",
        text: "Close Safe Exam Browser",
      });
      leave.addEventListener("click", () => {
        location.href = sebQuitUrl();
      });
      stateEl.append(leave);
    }
  } else {
    restore();
    window.addEventListener("beforeunload", guardUnload);
  }

  // Leaving mid-exam is one click too easy with a Back button on screen.
  showBack(preview);
  formEl.hidden = false;
  renderQuestion();

  if (data.state === "open") armTimer(data);
}

await loadExam();
