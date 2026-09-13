/**
 * The scheduled-test banner.
 *
 * A test with a clock on it is the only time-critical thing in this portal, so
 * it is promoted out of the Tests tab and pinned above the tabs on the
 * dashboard — a student who opens the site to read a notice still cannot miss
 * an exam closing in twenty minutes.
 *
 * Only one banner is ever shown. Two competing "urgent" strips would teach
 * students to ignore both.
 */
import { el } from "./ui.js";
import { formatClock, formatDateTime, formatDuration } from "./dates.js";

/** Inside this many milliseconds of the deadline, the banner turns amber. */
const SOON = 24 * 60 * 60 * 1000;

/** And inside this, red — it is now a "drop everything" message. */
const IMMINENT = 60 * 60 * 1000;

/**
 * Picks the test that most deserves the banner.
 *
 * Deadlines win over everything, soonest first, because they are the only
 * thing a student can actually miss. An undated test is still surfaced, but
 * only when nothing is scheduled.
 */
export function nextScheduledTest(tests) {
  const open = tests.filter(test => {
    if (test.status !== "published") return false;
    return !test.closes_at || new Date(test.closes_at) > new Date();
  });

  const dated = open
    .filter(test => test.closes_at)
    .sort((a, b) => new Date(a.closes_at) - new Date(b.closes_at));

  if (dated.length) return dated[0];

  return (
    [...open].sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0))[0] ?? null
  );
}

function toneFor(test) {
  if (!test.closes_at) return { tone: "live", label: "Test available" };

  const left = new Date(test.closes_at) - Date.now();
  if (left <= IMMINENT) return { tone: "soon", label: "Closing now" };
  if (left <= SOON) return { tone: "soon", label: "Closing soon" };
  return { tone: "live", label: "Scheduled test" };
}

/**
 * Builds the banner, or returns null when there is nothing worth promoting.
 *
 * @param {object[]} tests Published tests the student has not yet attempted.
 * @param {(test: object) => void} onStart Runs when Start is pressed.
 * @returns {HTMLElement|null}
 */
export function examAlert(tests, onStart) {
  const test = nextScheduledTest(tests);
  if (!test) return null;

  const { tone, label } = toneFor(test);

  const facts = [test.subject];
  if (test.duration_minutes) facts.push(formatDuration(test.duration_minutes));
  if (test.closes_at) facts.push(`closes ${formatDateTime(test.closes_at)}`);

  const main = el("div", { className: "exam-alert-main" }, [
    el("p", { className: "exam-alert-eyebrow" }, [
      el("span", { className: "exam-alert-dot" }),
      el("span", { text: label }),
    ]),
    el("h3", { text: test.title }),
    el("p", { className: "exam-alert-meta", text: facts.join(" · ") }),
  ]);

  const startBtn = el("button", { type: "button", className: "start-btn", text: "Start Test" });
  startBtn.addEventListener("click", () => onStart(test));

  const side = [startBtn];
  let stop = null;

  if (test.closes_at) {
    const value = el("span", { className: "count-value" });
    const countdown = el("div", { className: "exam-alert-countdown" }, [
      el("span", { className: "count-label", text: "Closes in" }),
      value,
    ]);

    const tick = () => {
      const left = new Date(test.closes_at) - Date.now();
      if (left <= 0) {
        // The deadline passed while the page sat open. Rather than show a
        // frozen 00:00, say so plainly; a reload will drop the banner.
        value.textContent = "Closed";
        clearInterval(stop);
        return;
      }
      value.textContent = formatClock(left);
    };

    tick();
    stop = setInterval(tick, 1000);
    side.unshift(countdown);
  }

  const banner = el("section", { className: `exam-alert exam-alert-${tone}` }, [
    main,
    el("div", { className: "exam-alert-side" }, side),
  ]);

  // The dashboard re-renders its lists on every reload; without this the old
  // banner's interval would keep firing against a detached node.
  banner.addEventListener("exam-alert:dispose", () => stop && clearInterval(stop));

  return banner;
}
