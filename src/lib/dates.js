/** Due-date formatting shared by the dashboard and admin assignment lists. */

/** Midnight today, so "due today" compares by calendar day, not by clock. */
function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Parses a `date` column ("2026-09-12") as a local calendar day.
 * `new Date("2026-09-12")` would parse as UTC midnight and can render as the
 * previous day for anyone west of Greenwich.
 */
export function parseDueDate(value) {
  if (!value) return null;

  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return null;

  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.valueOf()) ? null : date;
}

/**
 * Describes an assignment deadline.
 * @returns {{label: string, tone: "overdue"|"soon"|"ok"|"none", date: Date|null}}
 */
export function dueStatus(value) {
  const date = parseDueDate(value);
  if (!date) return { label: "No due date", tone: "none", date: null };

  const days = Math.round((date - startOfToday()) / 86400000);
  const formatted = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });

  if (days < 0) {
    const overdue = Math.abs(days);
    return { label: `Overdue by ${overdue} day${overdue === 1 ? "" : "s"}`, tone: "overdue", date };
  }
  if (days === 0) return { label: "Due today", tone: "soon", date };
  if (days === 1) return { label: "Due tomorrow", tone: "soon", date };
  if (days <= 7) return { label: `Due in ${days} days`, tone: "soon", date };

  return { label: `Due ${formatted}`, tone: "ok", date };
}

// --- exam scheduling -------------------------------------------------------

/** "12 Sep 2026, 14:30" — a deadline is a moment, not a calendar day. */
export function formatDateTime(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";

  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "1 hr 30 min" — reads better than "90 minutes" on a card. */
export function formatDuration(minutes) {
  const total = Number(minutes);
  if (!total || total < 1) return "";

  const hours = Math.floor(total / 60);
  const mins = total % 60;

  if (!hours) return `${mins} min`;
  return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
}

/**
 * Milliseconds as a countdown: "09:58", or "1:09:58" once it passes an hour.
 * Always rounds up, so a timer never shows 00:00 while time remains.
 */
export function formatClock(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const pad = value => String(value).padStart(2, "0");

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/**
 * An ISO timestamp as the local value a <input type="datetime-local"> wants.
 * The input has no timezone, so the UTC string cannot be handed to it as-is.
 */
export function toDatetimeLocal(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";

  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date - offset).toISOString().slice(0, 16);
}

/** The reverse: what a datetime-local input holds, as an ISO instant. */
export function fromDatetimeLocal(value) {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/** How a student sees a test's window on their dashboard. */
export function scheduleLabel({ closes_at: closesAt, duration_minutes: duration }) {
  const parts = [];

  if (duration) parts.push(`${formatDuration(duration)} to complete`);
  if (closesAt) {
    const closed = new Date(closesAt) < new Date();
    parts.push(
      closed ? `Closed ${formatDateTime(closesAt)}` : `Closes ${formatDateTime(closesAt)}`
    );
  }

  return parts.join(" · ");
}

/** True once a test's deadline has passed. */
export function isClosed(test) {
  return Boolean(test?.closes_at) && new Date(test.closes_at) < new Date();
}

/**
 * "3 hours ago", "in 2 days" — the form a notice board and a countdown both
 * want. Past and future share one function so the two never drift apart.
 */
export function relativeTime(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";

  const seconds = Math.round((date - Date.now()) / 1000);
  const abs = Math.abs(seconds);

  const units = [
    [60, "second", 1],
    [3600, "minute", 60],
    [86400, "hour", 3600],
    [604800, "day", 86400],
    [2629800, "week", 604800],
    [31557600, "month", 2629800],
    [Infinity, "year", 31557600],
  ];

  if (abs < 45) return seconds < 0 ? "just now" : "in a moment";

  for (const [limit, unit, divisor] of units) {
    if (abs < limit) {
      const count = Math.round(abs / divisor);
      const plural = count === 1 ? unit : `${unit}s`;
      return seconds < 0 ? `${count} ${plural} ago` : `in ${count} ${plural}`;
    }
  }

  return "";
}

// --- assignment deadlines --------------------------------------------------

/**
 * The instant an assignment stops accepting work.
 *
 * due_date is a calendar day, so "due 12 September" gives the student all of
 * the 12th: the cut-off is midnight at the end of it. Mirrors
 * public.assignment_is_open() in migration 0011 — that function is what
 * actually enforces this; the copy here only decides what the page shows.
 *
 * @returns {Date|null} null when the assignment has no deadline.
 */
export function submissionDeadline(dueDate) {
  const date = parseDueDate(dueDate);
  if (!date) return null;

  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

/** True once an assignment has closed for submissions. */
export function isPastDue(dueDate) {
  const deadline = submissionDeadline(dueDate);
  return Boolean(deadline) && Date.now() >= deadline.valueOf();
}
