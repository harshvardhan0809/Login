/**
 * Bulk import: many questions pasted at once, in one plain-text layout.
 *
 *   Q1. What is the SI unit of force?
 *   A) Joule
 *   B) Newton
 *   C) Watt
 *   D) Pascal
 *   Answer: B
 *   Marks: 4
 *
 * The rules, which the panel also shows teachers:
 *
 *   - A question starts on a line beginning "Q1.", "Q1)", "Q:", "1." or "1)".
 *     "Bonus:" or "Bonus Q1." starts a bonus question instead.
 *   - The question text runs until the first option or field, so it may span
 *     several lines. LaTeX between $...$ is kept as written.
 *   - Options are lines starting "A)", "A.", or "(A)", letters A to J.
 *   - Answer: one letter for single correct; several ("A, C" or "AC") for
 *     multiple correct; a number for a numerical question (optionally
 *     "9.8 ± 0.1" to accept a range); any text for a short answer.
 *   - Optional fields: Marks (default 1, or 0 for bonus), Type (single,
 *     multiple, numerical, text) to override the guess, Tolerance, Bonus: yes.
 *
 * parseQuestions() is plain string handling with no DOM, so it can be tested
 * on its own; bulkImport.js is the panel that uses it.
 */

/** Same rule the database grades numerical answers with (parse_decimal). */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

// "1." needs a space after it, so a line starting "3.14 is..." stays text.
const START =
  /^\s*(?:(bonus)\s*(?:q(?:uestion)?\s*\d*)?\s*[:.)-]?\s*|q(?:uestion)?\s*\d*\s*[:.)-]\s*|\d+\s*[.)]\s+)/i;
const OPTION = /^\s*\(?([A-J])\s*[).:]\s+(.*)$/i;
const FIELD_LINE = /^\s*(answer|ans|correct|marks?|points?|type|tolerance|bonus)\s*[:=-]\s*(.*)$/i;
const YES_NO = /^(yes|no|y|n|true|false)$/i;

/**
 * A "Field: value" line. "Bonus:" counts only with a yes/no after it, so
 * "Bonus: Who proposed..." starts a bonus question instead.
 */
function fieldOf(line) {
  const match = line.match(FIELD_LINE);
  if (!match) return null;
  if (match[1].toLowerCase() === "bonus" && !YES_NO.test(match[2].trim())) return null;
  return match;
}

const TYPE_WORDS = {
  single: "single",
  "single correct": "single",
  mcq: "single",
  multiple: "multiple",
  "multiple correct": "multiple",
  numerical: "numerical",
  numeric: "numerical",
  number: "numerical",
  integer: "numerical",
  text: "text",
  "short answer": "text",
};

function optionId() {
  return crypto.randomUUID().slice(0, 8);
}

/** Splits the paste into one block of lines per question. */
function blocks(text) {
  const out = [];
  let current = null;

  for (const raw of String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const start = line.match(START);

    // A line like "1) 42" inside a question would look like a new question;
    // only treat it as one when it is not a field.
    if (start && !fieldOf(line) && line.slice(start[0].length).trim()) {
      current = { bonus: Boolean(start[1]), lines: [line.slice(start[0].length)] };
      out.push(current);
    } else if (start && start[1] && !line.slice(start[0].length).trim()) {
      // "Bonus:" on its own line, question text on the next.
      current = { bonus: true, lines: [] };
      out.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      // Text before the first question: keep it so it is reported, not lost.
      current = { bonus: false, lines: [line], orphan: true };
      out.push(current);
    }
  }

  return out;
}

/** "A, C" / "AC" / "a and c" -> ["A", "C"]; null if it is not only letters. */
function letterList(answer) {
  const cleaned = answer.toUpperCase().replace(/\b(AND|&)\b/g, ",");
  if (!/^[A-J](\s*[,/ ]?\s*[A-J])*$/.test(cleaned.trim())) return null;
  return [...new Set(cleaned.match(/[A-J]/g))];
}

/**
 * @returns {{questions: object[], problems: number}}
 *   Each question: { number, prompt, type, options, answerKey, points,
 *   tolerance, bonus, errors[] }
 */
export function parseQuestions(text) {
  const questions = blocks(text).map((block, index) => {
    const errors = [];
    const prompt = [];
    const options = [];
    const fields = {};
    let inOptions = false;

    for (const line of block.lines) {
      const field = fieldOf(line);
      const option = line.match(OPTION);

      if (field) {
        fields[field[1].toLowerCase()] = field[2].trim();
        inOptions = false;
      } else if (option) {
        options.push({ letter: option[1].toUpperCase(), text: option[2].trim() });
        inOptions = true;
      } else if (inOptions && line.trim() && options.length) {
        // A long option wrapped onto the next line.
        options[options.length - 1].text += ` ${line.trim()}`;
      } else if (!options.length) {
        prompt.push(line);
      } else if (line.trim()) {
        errors.push(`Text after the options that is not a field: "${line.trim().slice(0, 40)}"`);
      }
    }

    const promptText = prompt.join("\n").trim();
    if (block.orphan) errors.push("This text is not part of a question. Start questions with Q1.");
    if (!promptText) errors.push("The question text is missing.");

    const bonusField = (fields.bonus ?? "").toLowerCase();
    const bonus = block.bonus || ["yes", "y", "true", "1"].includes(bonusField);

    // Duplicate letters would make the answer ambiguous.
    const letters = options.map(option => option.letter);
    if (new Set(letters).size !== letters.length) errors.push("Two options share a letter.");

    const answer = fields.answer ?? fields.ans ?? fields.correct ?? "";
    const typeWord = (fields.type ?? "").toLowerCase();
    let type = TYPE_WORDS[typeWord] ?? null;
    if (typeWord && !type) errors.push(`Unknown type "${fields.type}".`);

    let answerKey = [];
    let tolerance = 0;
    const chosen = options.length ? letterList(answer) : null;

    if (!type) {
      if (options.length) type = chosen && chosen.length > 1 ? "multiple" : "single";
      else type = DECIMAL.test(answer.split(/±|\+\/-/)[0].trim()) ? "numerical" : "text";
    }

    if (!answer) {
      errors.push('No answer. Add a line like "Answer: B".');
    } else if (type === "single" || type === "multiple") {
      if (options.length < 2) errors.push("A choice question needs at least two options.");
      if (!chosen) {
        errors.push(`"${answer}" is not an option letter.`);
      } else {
        const missing = chosen.filter(letter => !letters.includes(letter));
        if (missing.length)
          errors.push(`The answer ${missing.join(", ")} is not one of the options.`);
        if (type === "single" && chosen.length > 1) {
          errors.push('Several answers given for a single-correct question. Use "Type: multiple".');
        }
        answerKey = chosen;
      }
    } else if (type === "numerical") {
      const [value, range] = answer.split(/±|\+\/-/).map(part => part.trim());
      if (!DECIMAL.test(value)) errors.push(`"${value}" is not a plain number, like 2.5 or -12.`);
      answerKey = [value];

      const tol = fields.tolerance ?? range;
      if (tol !== undefined && tol !== "") {
        tolerance = Number(tol);
        if (!Number.isFinite(tolerance) || tolerance < 0) {
          errors.push("Tolerance must be a number of 0 or more.");
          tolerance = 0;
        }
      }
      if (options.length) errors.push("A numerical question should not have options.");
    } else {
      answerKey = [answer];
      if (options.length)
        errors.push('Options given for a short-answer question. Remove "Type: text".');
    }

    const marksField = fields.marks ?? fields.mark ?? fields.points ?? fields.point;
    let points = bonus ? 0 : 1;
    if (marksField !== undefined && marksField !== "") {
      points = Number(marksField);
      if (!Number.isFinite(points) || points < 0) {
        errors.push("Marks must be a number.");
        points = bonus ? 0 : 1;
      } else if (!bonus && points === 0) {
        errors.push("Only a bonus question can be worth 0 marks.");
      }
    }

    return {
      number: index + 1,
      prompt: promptText,
      type,
      options: type === "single" || type === "multiple" ? options : [],
      answerKey,
      points,
      tolerance,
      bonus,
      errors,
    };
  });

  return {
    questions,
    problems: questions.filter(question => question.errors.length).length,
  };
}

/** Rows ready for `questions`, in paste order after the existing ones. */
export function toRows(questions, testId, firstPosition) {
  const anyBonus = questions.some(question => question.bonus);
  const anyNumerical = questions.some(question => question.type === "numerical");

  return questions.map((question, index) => {
    const ids = question.options.map(() => optionId());
    const idOf = letter => ids[question.options.findIndex(option => option.letter === letter)];

    return {
      test_id: testId,
      prompt: question.prompt,
      type: question.type,
      options: question.options.map((option, i) => ({ id: ids[i], text: option.text })),
      answer_key:
        question.type === "single" || question.type === "multiple"
          ? question.answerKey.map(idOf)
          : question.answerKey,
      points: question.points,
      position: firstPosition + index,
      // A bulk insert needs the same columns on every row, and these two only
      // exist after migrations 0017 and 0019 -- so they are sent only when the
      // paste needs them.
      ...(anyNumerical ? { tolerance: question.tolerance } : {}),
      ...(anyBonus ? { is_bonus: question.bonus } : {}),
    };
  });
}

export const LAYOUT_EXAMPLE = `Q1. What is the SI unit of force?
A) Joule
B) Newton
C) Watt
D) Pascal
Answer: B
Marks: 4

Q2. Which of these are prime numbers?
A) 2
B) 9
C) 11
D) 15
Answer: A, C

Q3. A car covers 120 km in 2 hours. Find its speed in km/h.
Answer: 60

Q4. Find $g$ in m/s$^2$, to one decimal place.
Answer: 9.8 ± 0.1

Q5. Name the gas plants absorb for photosynthesis.
Answer: carbon dioxide

Bonus: Who proposed $E = mc^2$?
A) Newton
B) Einstein
C) Bohr
D) Curie
Answer: B
Marks: 0`;
