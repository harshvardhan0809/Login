/**
 * How a test's negative marking is described to people.
 *
 * `negative_marking` is stored as the fraction of a question's marks lost for
 * a wrong answer, because that scales with questions of different weights.
 * Teachers and students think in fractions ("a quarter") or in the familiar
 * +4 / -1 shorthand, so that is what is shown.
 */
const NAMES = new Map([
  [0.25, "¼"],
  [0.3333, "⅓"],
  [1 / 3, "⅓"],
  [0.5, "½"],
  [0.75, "¾"],
  [1, "all"],
]);

/** "¼ of the marks", or null when a test has no negative marking. */
export function penaltyLabel(fraction) {
  const value = Number(fraction) || 0;
  if (value <= 0) return null;

  const name = NAMES.get(Number(value.toFixed(4))) ?? NAMES.get(value);
  return name === "all" ? "all of the marks" : `${name ?? `${value * 100}%`} of the marks`;
}

/** "−1" for a 4-mark question at a quarter; null when there is no penalty. */
export function penaltyFor(points, fraction) {
  const value = Number(fraction) || 0;
  if (value <= 0) return null;

  const lost = (Number(points) || 0) * value;
  if (!lost) return null;
  return `−${Number(lost.toFixed(2))}`;
}

/** The sentence students are shown before and during the test. */
export function penaltySentence(fraction) {
  const label = penaltyLabel(fraction);
  return label
    ? `A wrong answer loses ${label} for that question. Leaving one blank costs nothing.`
    : null;
}
