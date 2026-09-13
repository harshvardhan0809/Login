/**
 * Turning a pile of result rows into something a teacher can act on.
 *
 * Everything here is a pure function over rows the admin has already loaded,
 * so the whole analysis page recomputes from memory when the teacher switches
 * test — no round trip, no spinner.
 *
 * The interesting half is item analysis: not "the class averaged 62%" but
 * "question 7 was answered wrongly by two thirds of them, and almost all of
 * those picked the same wrong option". The first is a grade; the second tells
 * you what to reteach.
 */

/** Rounds to one decimal place, which is as much precision as a class of 30 earns. */
const round1 = value => Math.round(value * 10) / 10;

/**
 * Headline numbers for one test.
 * @param {{score: number, total: number, percentage: number}[]} results
 */
export function scoreStats(results, passMark = 40) {
  if (!results.length) {
    return { count: 0, mean: 0, median: 0, high: 0, low: 0, passRate: 0, spread: 0 };
  }

  const percentages = results.map(r => Number(r.percentage) || 0).sort((a, b) => a - b);
  const count = percentages.length;
  const sum = percentages.reduce((total, value) => total + value, 0);
  const mean = sum / count;

  // Even counts average the middle pair rather than leaning to one side.
  const mid = Math.floor(count / 2);
  const median = count % 2 ? percentages[mid] : (percentages[mid - 1] + percentages[mid]) / 2;

  const variance = percentages.reduce((total, v) => total + (v - mean) ** 2, 0) / count;

  return {
    count,
    mean: round1(mean),
    median: round1(median),
    high: percentages[count - 1],
    low: percentages[0],
    passRate: round1((percentages.filter(p => p >= passMark).length / count) * 100),
    // Standard deviation: a class that all scored 60 needs different teaching
    // from one that split evenly between 20 and 100, and the mean hides that.
    spread: round1(Math.sqrt(variance)),
  };
}

/** Ten-point bands, so a 30-student class still has a readable shape. */
export function distribution(results) {
  const bands = Array.from({ length: 10 }, (_, index) => ({
    from: index * 10,
    to: index * 10 + 9,
    label: `${index * 10}–${index * 10 + 9}`,
    count: 0,
  }));

  // 100% belongs in the top band, not an eleventh one of its own.
  bands[9].to = 100;
  bands[9].label = "90–100";

  for (const result of results) {
    const pct = Math.max(0, Math.min(100, Number(result.percentage) || 0));
    bands[Math.min(9, Math.floor(pct / 10))].count += 1;
  }

  return bands;
}

/** Turns a stored answer key back into the text a teacher would recognise. */
function describeAnswer(question, key) {
  if (question.type === "text") return key;

  const options = Array.isArray(question.options) ? question.options : [];
  const labels = key
    .split("|")
    .map(id => options.find(option => option.id === id)?.text ?? "?")
    .filter(Boolean);

  return labels.join(" + ") || "—";
}

/** Four bands, named the way a teacher would describe the question. */
function difficultyOf(percentCorrect) {
  if (percentCorrect >= 80) return { label: "Easy", tone: "easy" };
  if (percentCorrect >= 50) return { label: "Moderate", tone: "moderate" };
  if (percentCorrect >= 25) return { label: "Hard", tone: "hard" };
  return { label: "Very hard", tone: "critical" };
}

/** A choice question's answer as a stable key, so a set of ids tallies cleanly. */
function answerKeyOf(given) {
  if (given === null || given === undefined) return null;
  if (Array.isArray(given)) return given.length ? [...given].sort().join("|") : null;

  const text = String(given).trim();
  return text ? text.toLowerCase() : null;
}

/**
 * Per-question performance, including which wrong answer was most popular.
 *
 * @param {object[]} questions Rows from `questions`, in display order.
 * @param {object[]} results Rows from `results`, each carrying `detail`.
 */
export function questionAnalysis(questions, results) {
  // One pass over every student's detail array, bucketed by question.
  const stats = new Map();
  for (const question of questions) {
    stats.set(question.id, { attempts: 0, correct: 0, answers: new Map() });
  }

  for (const result of results) {
    const detail = Array.isArray(result.detail) ? result.detail : [];

    for (const entry of detail) {
      const bucket = stats.get(entry.q);
      // A question added after this attempt has no data from it; skip rather
      // than inventing a wrong answer the student never had a chance to give.
      if (!bucket) continue;

      bucket.attempts += 1;
      if (entry.correct) bucket.correct += 1;

      const key = answerKeyOf(entry.given);
      if (key === null) {
        bucket.blank = (bucket.blank ?? 0) + 1;
      } else if (!entry.correct) {
        bucket.answers.set(key, (bucket.answers.get(key) ?? 0) + 1);
      }
    }
  }

  return questions.map((question, index) => {
    const bucket = stats.get(question.id);
    const attempts = bucket.attempts;
    const percentCorrect = attempts ? round1((bucket.correct / attempts) * 100) : 0;

    // The single wrong answer that caught the most students. For a choice
    // question this is the distractor worth discussing in class.
    let topWrong = null;
    let topWrongCount = 0;
    for (const [key, count] of bucket.answers) {
      if (count > topWrongCount) {
        topWrong = key;
        topWrongCount = count;
      }
    }

    return {
      question,
      number: index + 1,
      attempts,
      correct: bucket.correct,
      blank: bucket.blank ?? 0,
      percentCorrect,
      difficulty: difficultyOf(percentCorrect),
      topWrong: topWrong
        ? { answer: describeAnswer(question, topWrong), count: topWrongCount }
        : null,
    };
  });
}

/** How one student did, question by question, for the per-student table. */
export function studentRows(results, questions) {
  const order = questions.map(q => q.id);

  return results
    .map(result => {
      const detail = Array.isArray(result.detail) ? result.detail : [];
      const byQuestion = new Map(detail.map(entry => [entry.q, entry]));

      return {
        email: result.email,
        score: Number(result.score) || 0,
        total: Number(result.total) || 0,
        percentage: Number(result.percentage) || 0,
        attemptedAt: result.attempted_at,
        // Aligned to the question order so every row's Nth cell is question N,
        // even for a student who attempted before a question was added.
        marks: order.map(id => byQuestion.get(id)?.correct ?? null),
        hasDetail: detail.length > 0,
      };
    })
    .sort((a, b) => b.percentage - a.percentage);
}

/** Escapes one CSV cell. Quotes are doubled; anything risky gets wrapped. */
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {(string|number)[][]} rows Header row first. */
export function toCsv(rows) {
  return rows.map(row => row.map(csvCell).join(",")).join("\n");
}

/**
 * Hands the browser a file to save.
 *
 * Note this cannot work inside Safe Exam Browser, which blocks downloads by
 * design — export is a thing teachers do on the admin page, in a normal
 * browser, so that is fine.
 */
export function downloadCsv(filename, csv) {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();

  // Revoked on the next tick: revoking synchronously can cancel the download
  // in Safari before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
