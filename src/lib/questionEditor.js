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

const TYPES = [
  { value: "single", label: "Single choice", hint: "One correct option" },
  { value: "multiple", label: "Multiple choice", hint: "Several correct options" },
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
function composer(testId, onSaved, nextPosition) {
  const state = { type: "single", options: [], answerKey: [] };

  const prompt = el("input", { type: "text", placeholder: "What is 7 x 8?" });
  const points = el("input", { type: "number", value: "1", min: "1", step: "1" });
  const textAnswer = el("input", { type: "text", placeholder: "Accepted answer" });
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

    optionsBox.hidden = isText;
    addOptionBtn.hidden = isText;
    textField.hidden = !isText;

    if (!isText && state.options.length === 0) {
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

  saveBtn.addEventListener("click", async () => {
    const text = prompt.value.trim();
    if (!text) return toast("Enter the question.", "error");

    let options = [];
    let answerKey;

    if (state.type === "text") {
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

    const reset = setBusy(saveBtn, "Adding...");
    const { error } = await supabase.from("questions").insert([
      {
        test_id: testId,
        prompt: text,
        type: state.type,
        options,
        answer_key: answerKey,
        points: Number(points.value) || 1,
        position: nextPosition(),
      },
    ]);
    reset();

    if (error) {
      console.error("Add question failed:", error.message);
      toast(
        error.code === "PGRST205"
          ? "Run supabase/migrations/0007_builtin_exams.sql to enable built-in tests."
          : errorMessage(error, "Could not add the question."),
        "error"
      );
      return;
    }

    clear(prompt);
    points.value = "1";
    clear(textAnswer);
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
    ]),
    el("div", { className: "answer-area" }, [optionsBox, addOptionBtn, textField]),
    saveBtn,
  ]);

  syncType();
  return box;
}

function questionRow(question, reload) {
  const typeLabel = TYPES.find(t => t.value === question.type)?.label ?? question.type;

  const answerText =
    question.type === "text"
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

  return el("article", { className: "test-card" }, [
    el("div", { className: "test-info" }, [
      mathText("h4", {}, question.prompt),
      el("p", { text: `${typeLabel} · ${question.points} mark(s)` }),
      mathText("small", { className: "seb-note" }, `Answer: ${answerText || "not set"}`),
    ]),
    el("div", { className: "admin-actions" }, [remove]),
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
    count.textContent = countLabel(rows.length, "question");
    renderList(listBox, rows, question => questionRow(question, reload), "No questions yet.");
  }

  const backBtn = el("button", { type: "button", className: "secondary", text: "Back to tests" });
  backBtn.addEventListener("click", onBack);

  container.replaceChildren(
    el("div", { className: "section-title" }, [
      el("h2", { text: `Questions — ${test.title}` }),
      backBtn,
    ]),
    composer(test.id, reload, () => questionCount),
    el("div", { className: "section-title" }, [el("h2", { text: "Current Questions" }), count]),
    listBox
  );

  reload();
}
