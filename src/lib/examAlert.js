/**
 * The scheduled-test banner.
 *
 * A test with a clock on it is the only time-critical thing in this portal, so
 * it is promoted out of the Tests tab and pinned above the tabs on the
 * dashboard — a student who opens the site to read a notice still cannot miss
 * an exam closing in twenty minutes, or one starting in ten.
 *
 * Only one banner is ever shown. Two competing "urgent" strips would teach
 * students to ignore both.
 */
import { el } from "./ui.js";
import { formatCountdown, formatDateTime, formatDuration, testWindow } from "./dates.js";

/** Inside this many milliseconds of the deadline, the banner turns amber. */
const SOON = 24 * 60 * 60 * 1000;

/** And inside this, red — it is now a "drop everything" message. */
const IMMINENT = 60 * 60 * 1000;

/**
 * How many times one test may refresh the dashboard by itself.
 *
 * When a start time arrives the dashboard reloads so the server can confirm
 * the test is open. If the browser's clock runs ahead of the server's, that
 * reload comes back still showing "upcoming" and would immediately want to
 * reload again — an endless loop that makes the page unusable. A few seconds
 * of skew resolves within this budget; anything worse stops here and leaves
 * the student a button that works.
 */
const MAX_AUTO_REFRESH = 3;
const refreshesUsed = new Map();

function mayAutoRefresh(testId) {
  const used = refreshesUsed.get(testId) ?? 0;
  if (used >= MAX_AUTO_REFRESH) return false;

  refreshesUsed.set(testId, used + 1);
  return true;
}

/**
 * Picks the test that most deserves the banner.
 *
 * A test already open outranks one that has not started, however soon that
 * is: the student can act on the first and only wait for the second. Within
 * each group the nearest moment wins.
 */
export function nextScheduledTest(tests) {
  const live = [];
  const upcoming = [];

  for (const test of tests) {
    if (test.status !== "published") continue;

    const { state, opensAt } = testWindow(test);
    if (state === "closed") continue;
    if (state === "upcoming") upcoming.push({ test, at: opensAt });
    else live.push(test);
  }

  if (live.length) {
    const dated = live
      .filter(test => test.closes_at)
      .sort((a, b) => new Date(a.closes_at) - new Date(b.closes_at));

    if (dated.length) return dated[0];
    return [...live].sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0))[0];
  }

  upcoming.sort((a, b) => a.at - b.at);
  return upcoming[0]?.test ?? null;
}

/** Eyebrow wording and colour, from how close the next moment is. */
function toneFor(test) {
  const { state, opensAt, closesAt } = testWindow(test);

  if (state === "upcoming") {
    const until = opensAt - Date.now();
    return {
      tone: until <= SOON ? "soon" : "upcoming",
      label: until <= IMMINENT ? "Starting shortly" : "Scheduled test",
      // Before it opens the only number that matters is the wait.
      countdownLabel: "Starts in",
      target: opensAt,
      ready: false,
    };
  }

  if (!closesAt) {
    return { tone: "live", label: "Test available", countdownLabel: null, ready: true };
  }

  const left = closesAt - Date.now();
  return {
    tone: left <= SOON ? "soon" : "live",
    label: left <= IMMINENT ? "Closing now" : "Test open",
    countdownLabel: "Closes in",
    target: closesAt,
    ready: true,
  };
}

/**
 * Builds the banner, or returns null when there is nothing worth promoting.
 *
 * @param {object[]} tests Published tests the student has not yet attempted.
 * @param {(test: object) => void} onStart Runs when Start is pressed.
 * @param {() => void} [onWindowChange] Runs when a test opens or closes while
 *   the page is sitting there, so the dashboard can re-read it from the server.
 * @returns {HTMLElement|null}
 */
export function examAlert(tests, onStart, onWindowChange = () => {}) {
  const test = nextScheduledTest(tests);
  if (!test) return null;

  const { tone, label, countdownLabel, target, ready } = toneFor(test);

  const facts = [test.subject];
  if (test.duration_minutes) facts.push(formatDuration(test.duration_minutes));
  if (!ready && test.opens_at) facts.push(`opens ${formatDateTime(test.opens_at)}`);
  else if (test.closes_at) facts.push(`closes ${formatDateTime(test.closes_at)}`);

  const main = el("div", { className: "exam-alert-main" }, [
    el("p", { className: "exam-alert-eyebrow" }, [
      el("span", { className: "exam-alert-dot" }),
      el("span", { text: label }),
    ]),
    el("h3", { text: test.title }),
    el("p", { className: "exam-alert-meta", text: facts.join(" · ") }),
  ]);

  const startBtn = el("button", {
    type: "button",
    className: "start-btn",
    text: ready ? "Start Test" : "Not open yet",
    disabled: !ready,
  });

  // Attached even while disabled: a disabled button fires no click, and the
  // countdown below enables this one in place the moment the test opens.
  startBtn.addEventListener("click", () => onStart(test));

  /** The start time arrived while the student was looking at the page. */
  function open() {
    startBtn.disabled = false;
    startBtn.textContent = "Start Test";

    // Pressable immediately, whatever the refresh budget says. If this browser
    // was early, the exam page re-checks against the server clock and shows
    // its own countdown rather than refusing.
    if (mayAutoRefresh(test.id)) onWindowChange();
  }

  const side = [startBtn];
  let stop = null;

  if (target) {
    const value = el("span", { className: "count-value" });
    const countdown = el("div", { className: "exam-alert-countdown" }, [
      el("span", { className: "count-label", text: countdownLabel }),
      value,
    ]);

    const tick = () => {
      const left = target - Date.now();

      if (left <= 0) {
        clearInterval(stop);
        value.textContent = ready ? "Closed" : "Open now";

        // A test that just opened becomes startable in place. One that just
        // closed needs the dashboard re-read so the banner moves on to
        // whatever is next.
        if (ready) {
          startBtn.disabled = true;
          if (mayAutoRefresh(test.id)) onWindowChange();
        } else {
          open();
        }
        return;
      }
      value.textContent = formatCountdown(left);
    };

    tick();
    // Once a minute is enough above an hour, and the display does not change
    // faster than that anyway; a per-second repaint of a three-day countdown
    // is pure waste.
    stop = setInterval(tick, target - Date.now() > 60 * 60 * 1000 ? 30000 : 1000);
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
