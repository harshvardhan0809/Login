/**
 * The Bulk Import panel in the question editor: paste, preview, confirm.
 * The layout it accepts is documented in bulkParse.js and shown in the panel.
 */
import { el, errorMessage, setBusy, toast } from "./ui.js";
import { mathText } from "./math.js";
import { supabase } from "./supabase.js";
import { LAYOUT_EXAMPLE, parseQuestions, toRows } from "./bulkParse.js";

const TYPE_NAMES = {
  single: "Single correct",
  multiple: "Multiple correct",
  numerical: "Numerical",
  text: "Short answer",
};

function previewCard(question) {
  const marks = question.points
    ? `${question.points} ${question.points === 1 ? "mark" : "marks"}`
    : "no marks";

  const head = el("div", { className: "test-title-row" }, [
    el("span", { className: "question-number", text: `#${question.number}` }),
    el("span", { className: "pill pill-draft", text: TYPE_NAMES[question.type] }),
    ...(question.bonus ? [el("span", { className: "pill pill-bonus", text: "Bonus" })] : []),
    ...(question.section
      ? [el("span", { className: "pill pill-section", text: question.section })]
      : []),
    el("span", { className: "import-marks", text: marks }),
  ]);

  const body = [head, mathText("p", { className: "import-prompt" }, question.prompt || "—")];

  if (question.options.length) {
    body.push(
      el(
        "ul",
        { className: "import-options" },
        question.options.map(option =>
          el(
            "li",
            {
              className: question.answerKey.includes(option.letter) ? "is-correct" : "",
            },
            [el("strong", { text: `${option.letter}) ` }), mathText("span", {}, option.text)]
          )
        )
      )
    );
  } else if (question.answerKey.length) {
    body.push(
      el("p", {
        className: "import-answer",
        text: `Answer: ${question.answerKey[0]}${question.tolerance ? ` (± ${question.tolerance})` : ""}`,
      })
    );
  }

  if (question.errors.length) {
    body.push(
      el(
        "ul",
        { className: "import-errors" },
        question.errors.map(error => el("li", { text: error }))
      )
    );
  }

  return el(
    "article",
    { className: `import-card${question.errors.length ? " has-errors" : ""}` },
    body
  );
}

/**
 * The Bulk Import panel for one test.
 * @param {string} testId
 * @param {() => Promise<void>} onSaved
 * @param {() => number} nextPosition Where the first imported question goes.
 */
export function bulkImportPanel(testId, onSaved, nextPosition) {
  const input = el("textarea", {
    rows: 14,
    spellcheck: false,
    placeholder: "Paste your questions here, in the layout below.",
    className: "import-input",
  });
  const previewBtn = el("button", { type: "button", className: "secondary", text: "Preview" });
  const addBtn = el("button", { type: "button", text: "Add questions", hidden: true });
  const exampleBtn = el("button", {
    type: "button",
    className: "link-btn",
    text: "Insert the example",
  });
  const summary = el("p", { className: "import-summary", hidden: true });
  const preview = el("div", { className: "import-preview" });

  let parsed = null;

  const reset = () => {
    parsed = null;
    addBtn.hidden = true;
    summary.hidden = true;
    preview.replaceChildren();
  };

  // Any edit invalidates the preview, so what is added is always what was shown.
  input.addEventListener("input", reset);
  exampleBtn.addEventListener("click", () => {
    input.value = LAYOUT_EXAMPLE;
    reset();
    input.focus();
  });

  previewBtn.addEventListener("click", () => {
    parsed = parseQuestions(input.value);
    const { questions, problems } = parsed;

    preview.replaceChildren(...questions.map(previewCard));
    summary.hidden = false;

    if (!questions.length) {
      summary.className = "import-summary is-error";
      summary.textContent = "No questions found. Start each one with Q1., Q2. and so on.";
      addBtn.hidden = true;
      return;
    }

    const bonus = questions.filter(question => question.bonus).length;
    const counted = `${questions.length} question${questions.length === 1 ? "" : "s"}${bonus ? ` (${bonus} bonus)` : ""}`;

    if (problems) {
      summary.className = "import-summary is-error";
      summary.textContent = `${counted} found — ${problems} ${problems === 1 ? "needs" : "need"} fixing (in red below). Fix the text above and preview again.`;
      addBtn.hidden = true;
    } else {
      summary.className = "import-summary is-ok";
      summary.textContent = `${counted} ready. Check them below, then add them.`;
      addBtn.hidden = false;
      addBtn.textContent = `Add ${questions.length} question${questions.length === 1 ? "" : "s"}`;
    }
  });

  addBtn.addEventListener("click", async () => {
    if (!parsed || parsed.problems || !parsed.questions.length) return;

    const rows = toRows(parsed.questions, testId, nextPosition());
    const done = setBusy(addBtn, "Adding...");
    const { error } = await supabase.from("questions").insert(rows);
    done();

    if (error) {
      console.error("Bulk import failed:", error.message);
      toast(
        /is_bonus|points_check/.test(error.message)
          ? "Run supabase/migrations/0019_bonus_questions.sql to import bonus questions."
          : /tolerance|questions_type_check/.test(error.message)
            ? "Run supabase/migrations/0017_cbt_numerical_and_shuffle.sql to import numerical questions."
            : errorMessage(error, "Could not add the questions. None were added."),
        "error"
      );
      return;
    }

    toast(`${rows.length} question${rows.length === 1 ? "" : "s"} added.`, "success");
    input.value = "";
    reset();
    await onSaved();
  });

  const rules = el("details", { className: "import-rules" }, [
    el("summary", { text: "Layout to use" }),
    el(
      "ul",
      {},
      [
        "Start each question with Q1., Q2. … (or 1., 2. …). Start a bonus question with Bonus:",
        "A line on its own like Section: Physics puts the questions after it in that section.",
        "The question text can run over several lines. Write maths as LaTeX between $…$.",
        "Put each option on its own line: A) … B) … C) … D) …",
        "Answer: B for one correct option, Answer: A, C for several.",
        "No options and a number as the answer makes a numerical question. Add ± 0.1 to accept a range.",
        "No options and words as the answer makes a short answer (matched ignoring capitals).",
        "Optional: Marks: 4 (default 1; bonus default 0), Type: single / multiple / numerical / text, Bonus: yes",
      ].map(rule => el("li", { text: rule }))
    ),
    el("pre", { className: "import-example", text: LAYOUT_EXAMPLE }),
  ]);

  return el("div", { className: "panel-form import-panel" }, [
    el("div", { className: "section-title" }, [el("h2", { text: "Bulk Import" }), exampleBtn]),
    el("p", {
      className: "sub",
      text: "Paste many questions at once. Nothing is added until you preview and confirm.",
    }),
    rules,
    input,
    el("div", { className: "submission-actions" }, [previewBtn, addBtn]),
    summary,
    preview,
  ]);
}
