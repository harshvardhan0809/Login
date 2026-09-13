/**
 * The teacher's analysis view.
 *
 * Everything is fetched once — tests, questions, results — and every switch of
 * the test picker recomputes from memory. A class of thirty with sixty
 * questions is a few hundred kilobytes, which is cheaper to hold than to
 * re-request each time a teacher compares two papers.
 */
import { supabase, isMissingTable } from "../lib/supabase.js";
import { requireAdmin, wireLogout } from "../lib/session.js";
import { countLabel, el, renderList, setNotice, toast } from "../lib/ui.js";
import { formatDateTime } from "../lib/dates.js";
import { mathText } from "../lib/math.js";
import {
  distribution,
  downloadCsv,
  questionAnalysis,
  scoreStats,
  studentRows,
  toCsv,
} from "../lib/analytics.js";

const testPicker = document.getElementById("testPicker");
const stateEl = document.getElementById("analysisState");
const bodyEl = document.getElementById("analysisBody");
const summaryEl = document.getElementById("summaryTiles");
const distributionEl = document.getElementById("distribution");
const distributionNote = document.getElementById("distributionNote");
const questionEl = document.getElementById("questionAnalysis");
const questionNote = document.getElementById("questionNote");
const studentEl = document.getElementById("studentTable");
const studentNote = document.getElementById("studentNote");
const exportBtn = document.getElementById("exportBtn");
const backBtn = document.getElementById("backBtn");

/** Below this a test is a fail. Matches the exam page's own pass line. */
const PASS_MARK = 40;

await requireAdmin();
wireLogout();
backBtn.addEventListener("click", () => location.replace("admin.html"));

let tests = [];
let questionsByTest = new Map();
let resultsByTest = new Map();

function tile(value, label, tone) {
  return el("div", { className: `stat-box${tone ? ` stat-${tone}` : ""}` }, [
    el("p", { className: "stat-value", text: String(value) }),
    el("p", { text: label }),
  ]);
}

function renderSummary(stats) {
  summaryEl.replaceChildren(
    tile(stats.count, "Attempts"),
    tile(`${stats.mean}%`, "Average"),
    tile(`${stats.median}%`, "Median"),
    tile(`${stats.passRate}%`, "Pass rate"),
    tile(`${stats.high}%`, "Highest"),
    tile(`${stats.low}%`, "Lowest"),
    // Standard deviation, named for what it tells a teacher rather than for
    // the statistic it is: a wide spread means the class split, not that it
    // struggled uniformly.
    tile(`±${stats.spread}`, "Spread")
  );
}

function renderDistribution(bands, total) {
  const peak = Math.max(...bands.map(band => band.count), 1);

  distributionNote.textContent = `${countLabel(total, "attempt")} across 10-point bands`;

  distributionEl.replaceChildren(
    ...bands.map(band => {
      const share = total ? Math.round((band.count / total) * 100) : 0;

      const bar = el("div", {
        className: `histogram-bar${band.from >= PASS_MARK ? " histogram-pass" : " histogram-fail"}`,
      });
      // Height is relative to the busiest band so the shape is readable even
      // when every band holds one or two students.
      bar.style.height = `${band.count ? Math.max(6, (band.count / peak) * 100) : 2}%`;
      bar.title = `${band.label}%: ${countLabel(band.count, "student")} (${share}%)`;

      return el("div", { className: "histogram-col" }, [
        el("span", { className: "histogram-count", text: band.count ? String(band.count) : "" }),
        el("div", { className: "histogram-track" }, [bar]),
        el("span", { className: "histogram-label", text: band.label }),
      ]);
    })
  );
}

function questionRow(item) {
  const { question, difficulty } = item;

  const bar = el("div", { className: `meter-fill meter-${difficulty.tone}` });
  bar.style.width = `${item.percentCorrect}%`;

  const facts = [`${item.correct}/${item.attempts} correct`];
  if (item.blank) facts.push(`${item.blank} left blank`);
  if (item.topWrong) {
    facts.push(`most common wrong answer: "${item.topWrong.answer}" (${item.topWrong.count})`);
  }

  return el("article", { className: "analysis-row" }, [
    el("div", { className: "analysis-row-head" }, [
      el("span", { className: "question-number", text: `Q${item.number}` }),
      mathText("p", { className: "question-prompt" }, question.prompt),
      el("span", { className: `pill pill-${difficulty.tone}`, text: difficulty.label }),
      el("span", { className: "analysis-pct", text: `${item.percentCorrect}%` }),
    ]),
    el("div", { className: "meter" }, [bar]),
    el("p", { className: "analysis-facts", text: facts.join(" · ") }),
  ]);
}

function renderQuestions(items) {
  const weakest = items.filter(item => item.percentCorrect < 50).length;

  questionNote.textContent = weakest
    ? `${weakest} question${weakest === 1 ? "" : "s"} under 50%`
    : "No question fell below 50%";

  renderList(
    questionEl,
    items,
    questionRow,
    "No per-question data yet. It is recorded from the next submission onwards."
  );
}

/** One header cell plus one cell per question, then the totals. */
function renderStudents(rows, questions) {
  studentNote.textContent = countLabel(rows.length, "student");

  if (!rows.length) {
    setNotice(studentEl, "Nobody has attempted this test yet.");
    return;
  }

  const head = el("tr", {}, [
    el("th", { text: "Student" }),
    ...questions.map((question, index) =>
      el("th", { className: "cell-q", title: question.prompt, text: `Q${index + 1}` })
    ),
    el("th", { className: "cell-num", text: "Score" }),
    el("th", { className: "cell-num", text: "%" }),
    el("th", { text: "Submitted" }),
  ]);

  const body = rows.map(row =>
    el("tr", {}, [
      el("td", { className: "cell-email", text: row.email }),
      ...row.marks.map(mark =>
        el("td", {
          className: `cell-q mark-${mark === null ? "none" : mark ? "right" : "wrong"}`,
          // A dash, not a blank: "no data" and "got it wrong" must not look
          // the same when a question was added after someone had attempted.
          text: mark === null ? "–" : mark ? "✓" : "✗",
        })
      ),
      el("td", { className: "cell-num", text: `${row.score}/${row.total}` }),
      el("td", {
        className: `cell-num ${row.percentage >= PASS_MARK ? "mark-right" : "mark-wrong"}`,
        text: `${row.percentage}%`,
      }),
      el("td", { className: "cell-date", text: formatDateTime(row.attemptedAt) }),
    ])
  );

  studentEl.replaceChildren(
    el("table", { className: "data-table" }, [el("thead", {}, [head]), el("tbody", {}, body)])
  );
}

function currentTest() {
  return tests.find(test => test.id === testPicker.value) ?? null;
}

function render() {
  const test = currentTest();
  if (!test) {
    bodyEl.hidden = true;
    setNotice(stateEl, "Create a test to see its analysis here.");
    return;
  }

  const questions = questionsByTest.get(test.id) ?? [];
  const results = resultsByTest.get(test.id) ?? [];

  if (!results.length) {
    bodyEl.hidden = true;
    setNotice(
      stateEl,
      `Nobody has submitted "${test.title}" yet. Its analysis appears here as soon as they do.`
    );
    return;
  }

  stateEl.replaceChildren();
  bodyEl.hidden = false;

  renderSummary(scoreStats(results, PASS_MARK));
  renderDistribution(distribution(results), results.length);
  renderQuestions(questionAnalysis(questions, results));
  renderStudents(studentRows(results, questions), questions);
}

function exportCurrent() {
  const test = currentTest();
  if (!test) return;

  const questions = questionsByTest.get(test.id) ?? [];
  const rows = studentRows(resultsByTest.get(test.id) ?? [], questions);

  if (!rows.length) {
    toast("There is nothing to export for this test yet.", "error");
    return;
  }

  const header = [
    "Student",
    ...questions.map((question, index) => `Q${index + 1}: ${question.prompt}`),
    "Score",
    "Total",
    "Percentage",
    "Submitted",
  ];

  const body = rows.map(row => [
    row.email,
    ...row.marks.map(mark => (mark === null ? "" : mark ? "correct" : "wrong")),
    row.score,
    row.total,
    row.percentage,
    formatDateTime(row.attemptedAt),
  ]);

  const slug = test.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  downloadCsv(`${slug || "test"}-results.csv`, toCsv([header, ...body]));
  toast("CSV exported.", "success");
}

async function load() {
  setNotice(stateEl, "Loading results...");

  const [testRows, questionRows, resultRows] = await Promise.all([
    supabase
      .from("tests")
      .select("id, title, subject, status")
      .order("created_at", { ascending: false }),
    supabase.from("questions").select("*").order("position", { ascending: true }),
    supabase.from("results").select("*").order("attempted_at", { ascending: false }),
  ]);

  if (testRows.error || resultRows.error) {
    const error = testRows.error ?? resultRows.error;
    console.error("Could not load analysis data:", error.message);
    setNotice(stateEl, "Could not load results. Please refresh and try again.", "error");
    return;
  }

  if (questionRows.error && !isMissingTable(questionRows.error)) {
    console.error("Could not load questions:", questionRows.error.message);
  }

  tests = testRows.data ?? [];

  questionsByTest = new Map();
  for (const question of questionRows.data ?? []) {
    if (!questionsByTest.has(question.test_id)) questionsByTest.set(question.test_id, []);
    questionsByTest.get(question.test_id).push(question);
  }

  resultsByTest = new Map();
  for (const result of resultRows.data ?? []) {
    // A result whose test was deleted has a null test_id and belongs to no
    // paper; it would otherwise create a phantom entry in the picker.
    if (!result.test_id) continue;
    if (!resultsByTest.has(result.test_id)) resultsByTest.set(result.test_id, []);
    resultsByTest.get(result.test_id).push(result);
  }

  // Tests with submissions first — they are the only ones worth opening.
  const ordered = [...tests].sort(
    (a, b) => (resultsByTest.get(b.id)?.length ?? 0) - (resultsByTest.get(a.id)?.length ?? 0)
  );

  testPicker.replaceChildren(
    ...ordered.map(test => {
      const count = resultsByTest.get(test.id)?.length ?? 0;
      return el("option", {
        value: test.id,
        text: `${test.title} — ${test.subject} (${countLabel(count, "attempt")})`,
      });
    })
  );

  if (!tests.length) {
    setNotice(stateEl, "No tests have been created yet.");
    return;
  }

  render();
}

testPicker.addEventListener("change", render);
exportBtn.addEventListener("click", exportCurrent);
await load();
