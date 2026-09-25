/**
 * The question builder teachers use instead of Google Forms.
 *
 * Renders into a container and takes it over until the teacher goes back, so
 * the editor gets the full width of the panel rather than being squeezed into
 * a card or a modal.
 */
import { supabase } from "./supabase.js";
import { countLabel, el, errorMessage, renderList, setBusy, setNotice, toast } from "./ui.js";
import { mathText } from "./math.js";
import { mathField, mathPalette } from "./mathField.js";
import { bulkImportPanel } from "./bulkImport.js";

const TYPES = [
  { value: "single", label: "Single choice", hint: "One correct option" },
  { value: "multiple", label: "Multiple choice", hint: "Several correct options" },
  { value: "numerical", label: "Numerical value", hint: "Student types a number" },
  { value: "text", label: "Short answer", hint: "Typed answer, matched exactly" },
];

/**
 * How many blank options a new choice question starts with.
 *
 * Four is what almost every multiple-choice paper uses, so the common case
 * needs no clicking at all. Options can still be added or removed.
 */
const DEFAULT_OPTIONS = 4;

/** Options carry stable ids so the answer key survives reordering and edits. */
function optionId() {
  return crypto.randomUUID().slice(0, 8);
}

function field(labelText, control, hint) {
  const children = [el("label", { text: labelText }), control];
  if (hint) children.push(el("small", { className: "hint", text: hint }));
  return el("div", { className: "field" }, children);
}

/**
 * Empties a box and tells its maths preview about it.
 *
 * Assigning to .value fires no event, so without this the preview under a
 * cleared box would keep showing the formula from the question just saved.
 */
function clear(input) {
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** One editable option row: correct-marker, text, remove. */
function optionRow(option, state, onChange) {
  const marker = el("input", {
    type: state.type === "multiple" ? "checkbox" : "radio",
    name: "correct-option",
    checked: state.answerKey.includes(option.id),
    title: "Mark as correct",
  });

  marker.addEventListener("change", () => {
    if (state.type === "multiple") {
      const keys = new Set(state.answerKey);
      marker.checked ? keys.add(option.id) : keys.delete(option.id);
      state.answerKey = [...keys];
    } else {
      state.answerKey = marker.checked ? [option.id] : [];
    }
    onChange();
  });

  const text = el("input", {
    type: "text",
    value: option.text,
    placeholder: "Option text",
  });
  text.addEventListener("input", () => {
    option.text = text.value;
  });

  const remove = el("button", { type: "button", className: "delete-btn", text: "Remove" });
  remove.addEventListener("click", () => {
    state.options = state.options.filter(other => other.id !== option.id);
    state.answerKey = state.answerKey.filter(id => id !== option.id);
    onChange();
  });

  // Each option previews on its own line: an option is often the formula that
  // distinguishes it from the others, and they must be checked side by side.
  return el("div", { className: "option-block" }, [
    el("div", { className: "option-row" }, [marker, text, remove]),
    mathField(text, "Option"),
  ]);
}

/** The "add a question" form. Calls onSave with a row ready for insert. */
function composer(testId, onSaved, nextPosition, sections = () => []) {
  const state = { type: "single", options: [], answerKey: [] };

  const prompt = el("input", { type: "text", placeholder: "What is 7 x 8?" });
  const points = el("input", { type: "number", value: "1", min: "1", step: "any" });
  const sectionInput = el("input", {
    type: "text",
    placeholder: "e.g. Physics — leave blank for one undivided paper",
  });
  // Offers the sections this test already uses, while allowing a new one.
  const sectionList = el("datalist", { id: "sectionOptions" });
  sectionInput.setAttribute("list", "sectionOptions");
  const bonusInput = el("input", { type: "checkbox" });
  const bonusField = el("label", { className: "checkbox-field" }, [
    bonusInput,
    el("span", {
      text: "Bonus question — its own section; adds to the score, never to the total",
    }),
  ]);

  // A bonus question may be worth nothing; a normal one must be worth something.
  bonusInput.addEventListener("change", () => {
    points.min = bonusInput.checked ? "0" : "1";
    if (bonusInput.checked && points.value === "1") points.value = "0";
    if (!bonusInput.checked && Number(points.value) <= 0) points.value = "1";
  });
  const textAnswer = el("input", { type: "text", placeholder: "Accepted answer" });
  const numberAnswer = el("input", { type: "text", inputMode: "decimal", placeholder: "e.g. 2.5" });
  const tolerance = el("input", { type: "number", value: "0", min: "0", step: "any" });
  const typeSelect = el(
    "select",
    {},
    TYPES.map(t => el("option", { value: t.value, text: t.label }))
  );

  const optionsBox = el("div", { className: "options-box" });
  const addOptionBtn = el("button", { type: "button", className: "secondary", text: "Add option" });
  const textField = field(
    "Correct answer",
    textAnswer,
    "Matched as plain text against what the student types, so keep it typeable: " +
      "x^2 or 3.14, not $x^{2}$. Case and surrounding spaces are ignored."
  );
  const numberField = el("div", { className: "form-stack" }, [
    field(
      "Correct answer",
      numberAnswer,
      "A plain number: digits, an optional minus sign and decimal point. " +
        "2.5, 2.50 and +2.5 are all accepted as the same answer."
    ),
    field(
      "Tolerance (±)",
      tolerance,
      "How far off an answer may be and still score. 0 means exact; 0.01 accepts 2.49 to 2.51."
    ),
  ]);
  const saveBtn = el("button", { type: "button", text: "Add Question" });

  const promptField = field("Question", prompt);
  promptField.append(mathField(prompt, "Question"));

  function renderOptions() {
    optionsBox.replaceChildren(
      ...state.options.map(option => optionRow(option, state, renderOptions))
    );
    if (!state.options.length) {
      optionsBox.append(
        el("p", { className: "notice", text: "No options yet. Add at least two." })
      );
    }
  }

  function syncType() {
    state.type = typeSelect.value;
    state.answerKey = [];
    const isText = state.type === "text";
    const isNumber = state.type === "numerical";
    const typed = isText || isNumber;

    optionsBox.hidden = typed;
    addOptionBtn.hidden = typed;
    textField.hidden = !isText;
    numberField.hidden = !isNumber;

    if (!typed && state.options.length === 0) {
      state.options = Array.from({ length: DEFAULT_OPTIONS }, () => ({
        id: optionId(),
        text: "",
      }));
    }
    renderOptions();
  }

  typeSelect.addEventListener("change", syncType);
  addOptionBtn.addEventListener("click", () => {
    state.options.push({ id: optionId(), text: "" });
    renderOptions();
  });

  const syncSections = () => {
    sectionList.replaceChildren(...sections().map(name => el("option", { value: name })));
  };
  sectionInput.addEventListener("focus", syncSections);

  saveBtn.addEventListener("click", async () => {
    const text = prompt.value.trim();
    if (!text) return toast("Enter the question.", "error");

    let options = [];
    let answerKey;
    let tol = 0;

    if (state.type === "numerical") {
      const value = numberAnswer.value.trim();
      // Same rule the database grades with (parse_decimal in migration 0017).
      if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(value)) {
        return toast("Enter the correct answer as a plain number, like 2.5 or -12.", "error");
      }
      tol = Number(tolerance.value || 0);
      if (!Number.isFinite(tol) || tol < 0) return toast("Tolerance must be 0 or more.", "error");
      answerKey = [value];
    } else if (state.type === "text") {
      const accepted = textAnswer.value.trim();
      if (!accepted) return toast("Enter the correct answer.", "error");
      answerKey = [accepted];
    } else {
      options = state.options
        .map(option => ({ id: option.id, text: option.text.trim() }))
        .filter(option => option.text);

      if (options.length < 2) return toast("Add at least two options.", "error");

      answerKey = state.answerKey.filter(id => options.some(option => option.id === id));
      if (!answerKey.length) return toast("Mark which option is correct.", "error");
    }

    const isBonus = bonusInput.checked;
    const marks = points.value.trim() === "" ? (isBonus ? 0 : 1) : Number(points.value);
    if (!Number.isFinite(marks) || marks < 0 || (!isBonus && marks <= 0)) {
      return toast(
        isBonus ? "Bonus marks must be 0 or more." : "Marks must be more than 0.",
        "error"
      );
    }

    const reset = setBusy(saveBtn, "Adding...");
    const { error } = await supabase.from("questions").insert([
      {
        test_id: testId,
        prompt: text,
        type: state.type,
        options,
        answer_key: answerKey,
        points: marks,
        position: nextPosition(),
        // Only numerical questions carry one; sent only then, so adding other
        // questions keeps working before migration 0017 is run.
        ...(state.type === "numerical" ? { tolerance: tol } : {}),
        // Likewise sent only when set, so nothing breaks before 0019 is run.
        ...(isBonus ? { is_bonus: true } : {}),
        ...(sectionInput.value.trim() ? { section: sectionInput.value.trim().slice(0, 60) } : {}),
      },
    ]);
    reset();

    if (error) {
      console.error("Add question failed:", error.message);
      toast(
        error.code === "PGRST205"
          ? "Run supabase/migrations/0007_builtin_exams.sql to enable built-in tests."
          : sectionInput.value.trim() && /section/.test(error.message)
            ? "Run supabase/migrations/0020_sections_and_negative_marking.sql to use sections."
            : isBonus && /is_bonus|points_check/.test(error.message)
              ? "Run supabase/migrations/0019_bonus_questions.sql to enable bonus questions."
              : state.type === "numerical" && /tolerance|questions_type_check/.test(error.message)
                ? "Run supabase/migrations/0017_cbt_numerical_and_shuffle.sql to enable numerical questions."
                : errorMessage(error, "Could not add the question."),
        "error"
      );
      return;
    }

    clear(prompt);
    points.value = isBonus ? "0" : "1";
    clear(textAnswer);
    numberAnswer.value = "";
    tolerance.value = "0";
    state.options = [];
    state.answerKey = [];
    syncType();
    toast("Question added.", "success");
    await onSaved();
  });

  const box = el("div", { className: "panel-form" }, [
    el("h2", { text: "Add Question" }),
    // One palette for the whole composer: it types into the question box, an
    // option box, or the answer box — whichever was last focused.
    mathPalette(prompt),
    el("div", { className: "form-stack" }, [
      promptField,
      field("Type", typeSelect),
      field("Marks", points),
      field("Section", sectionInput, "Questions sharing a section stay together on the paper."),
      bonusField,
    ]),
    el("div", { className: "answer-area" }, [optionsBox, addOptionBtn, textField, numberField]),
    sectionList,
    saveBtn,
  ]);

  syncType();
  return box;
}

function questionRow(question, reload) {
  const typeLabel = TYPES.find(t => t.value === question.type)?.label ?? question.type;

  const tol = Number(question.tolerance) || 0;
  const answerText =
    question.type === "numerical"
      ? `${(question.answer_key ?? []).join(", ")}${tol ? ` (± ${tol})` : ""}`
      : question.type === "text"
        ? (question.answer_key ?? []).join(", ")
        : (question.options ?? [])
            .filter(option => (question.answer_key ?? []).includes(option.id))
            .map(option => option.text)
            .join(", ");

  const remove = el("button", { type: "button", className: "delete-btn", text: "Delete" });
  remove.addEventListener("click", async () => {
    if (!confirm(`Delete this question?\n\n"${question.prompt}"`)) return;

    const reset = setBusy(remove, "Deleting...");
    const { error } = await supabase.from("questions").delete().eq("id", question.id);
    reset();

    if (error) {
      toast(errorMessage(error, "Could not delete the question."), "error");
      return;
    }
    toast("Question deleted.", "success");
    await reload();
  });

  // Moving a question between the main paper and the bonus section. A bonus
  // question worth 0 marks has to be worth something to become a normal one.
  const toggle = el("button", {
    type: "button",
    className: "edit-btn",
    text: question.is_bonus ? "Make regular" : "Make bonus",
  });
  toggle.addEventListener("click", async () => {
    const becomingBonus = !question.is_bonus;
    const update = { is_bonus: becomingBonus };
    if (!becomingBonus && !(Number(question.points) > 0)) update.points = 1;

    const reset = setBusy(toggle, "Saving...");
    const { error } = await supabase.from("questions").update(update).eq("id", question.id);
    reset();

    if (error) {
      toast(
        /is_bonus/.test(error.message)
          ? "Run supabase/migrations/0019_bonus_questions.sql to enable bonus questions."
          : errorMessage(error, "Could not change the question."),
        "error"
      );
      return;
    }
    toast(becomingBonus ? "Moved to the bonus section." : "Moved to the main paper.", "success");
    await reload();
  });

  const marks = Number(question.points) || 0;
  const marksText = marks ? `${marks} ${marks === 1 ? "mark" : "marks"}` : "no marks";

  return el("article", { className: "test-card" }, [
    el("div", { className: "test-info" }, [
      el("div", { className: "test-title-row" }, [
        mathText("h4", {}, question.prompt),
        ...(question.is_bonus ? [el("span", { className: "pill pill-bonus", text: "Bonus" })] : []),
        ...(question.section
          ? [el("span", { className: "pill pill-section", text: question.section })]
          : []),
      ]),
      el("p", { text: `${typeLabel} · ${marksText}` }),
      mathText("small", { className: "seb-note" }, `Answer: ${answerText || "not set"}`),
    ]),
    el("div", { className: "admin-actions" }, [toggle, remove]),
  ]);
}

/**
 * Renders the editor for one test.
 * @param {HTMLElement} container Taken over until onBack is pressed.
 * @param {object} test
 * @param {Function} onBack
 */
export function openQuestionEditor(container, test, onBack) {
  const listBox = el("div", {});
  /** Section names already in use, offered by the composer's Section box. */
  let sectionNames = [];
  const count = el("span", { text: "0 questions" });
  let questionCount = 0;

  async function reload() {
    setNotice(listBox, "Loading questions...");

    const { data, error } = await supabase
      .from("questions")
      .select("*")
      .eq("test_id", test.id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Load questions failed:", error.message);
      setNotice(
        listBox,
        error.code === "PGRST205"
          ? "Run supabase/migrations/0007_builtin_exams.sql to enable built-in tests."
          : "Could not load questions.",
        "error"
      );
      return;
    }

    const rows = data ?? [];
    questionCount = rows.length;

    const main = rows.filter(question => !question.is_bonus);
    const bonus = rows.filter(question => question.is_bonus);
    const marks = main.reduce((sum, question) => sum + (Number(question.points) || 0), 0);
    count.textContent =
      `${countLabel(main.length, "question")} · ${marks} marks` +
      (bonus.length ? ` · ${bonus.length} bonus` : "");

    // The sections a teacher has used, in the order the paper shows them.
    const sections = [...new Set(main.map(question => question.section ?? ""))];
    sectionNames = sections.filter(Boolean);

    if (sections.length > 1) {
      listBox.replaceChildren();
      for (const section of sections) {
        const inSection = main.filter(question => (question.section ?? "") === section);
        const sectionMarks = inSection.reduce((sum, q) => sum + (Number(q.points) || 0), 0);
        const box = el("div", {});
        renderList(box, inSection, question => questionRow(question, reload), "");
        listBox.append(
          el("div", { className: "section-title" }, [
            el("h3", { text: section || "No section" }),
            el("span", {
              text: `${countLabel(inSection.length, "question")} · ${sectionMarks} marks`,
            }),
          ]),
          box
        );
      }
    } else {
      renderList(listBox, main, question => questionRow(question, reload), "No questions yet.");
    }

    // Bonus questions are their own section, as they are on the paper.
    if (bonus.length) {
      const bonusMarks = bonus.reduce((sum, question) => sum + (Number(question.points) || 0), 0);
      const bonusList = el("div", {});
      renderList(bonusList, bonus, question => questionRow(question, reload), "");
      listBox.append(
        el("div", { className: "section-title" }, [
          el("h2", { text: "Bonus Questions" }),
          el("span", {
            text: bonusMarks
              ? `up to ${bonusMarks} extra marks, capped at full marks`
              : "no marks — for practice",
          }),
        ]),
        bonusList
      );
    }
  }

  const backBtn = el("button", { type: "button", className: "secondary", text: "Back to tests" });
  backBtn.addEventListener("click", onBack);

  container.replaceChildren(
    el("div", { className: "section-title" }, [
      el("h2", { text: `Questions — ${test.title}` }),
      backBtn,
    ]),
    composer(
      test.id,
      reload,
      () => questionCount,
      () => sectionNames
    ),
    bulkImportPanel(test.id, reload, () => questionCount),
    el("div", { className: "section-title" }, [el("h2", { text: "Current Questions" }), count]),
    listBox
  );

  reload();
}
