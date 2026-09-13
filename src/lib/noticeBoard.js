/**
 * The notice board, shared by the student dashboard and the admin panel.
 *
 * A board is only useful if the important thing is obvious without reading
 * everything, so each notice carries three signals that survive skim-reading:
 * a coloured left rule for priority, a category chip, and pinning. Sorting
 * follows the same order, so the visual weight of the list matches the order
 * a reader's eye travels down it.
 */
import { el } from "./ui.js";
import { relativeTime } from "./dates.js";

export const NOTICE_CATEGORIES = [
  { value: "general", label: "General" },
  { value: "academic", label: "Academic" },
  { value: "exam", label: "Exam" },
  { value: "event", label: "Event" },
  { value: "holiday", label: "Holiday" },
];

export const NOTICE_PRIORITIES = [
  { value: "normal", label: "Normal" },
  { value: "high", label: "Important" },
  { value: "urgent", label: "Urgent" },
];

const RANK = { urgent: 0, high: 1, normal: 2 };

const labelFor = (list, value) => list.find(item => item.value === value)?.label ?? list[0].label;

/**
 * Urgent first, then pinned, then newest.
 *
 * Deliberately not done in SQL: the board is at most a few dozen rows, and
 * keeping the rule here means the student and admin lists cannot disagree
 * about what "top of the board" means.
 */
export function sortNotices(notices) {
  return [...notices].sort((a, b) => {
    const priority = (RANK[a.priority] ?? 2) - (RANK[b.priority] ?? 2);
    if (priority) return priority;

    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

function dot() {
  return el("span", { className: "dot" });
}

/**
 * One notice.
 *
 * @param {object} notice Row from `notices`.
 * @param {Node[]} [actions] Admin controls, appended to the footer.
 */
export function noticeCard(notice, actions = []) {
  const priority = notice.priority ?? "normal";
  const pinned = Boolean(notice.pinned);

  const classes = ["notice-card", `notice-${priority}`];
  if (pinned) classes.push("notice-pinned");

  const head = [el("h4", { text: notice.title })];

  if (priority !== "normal") {
    head.push(
      el("span", {
        className: `pill pill-${priority}`,
        text: labelFor(NOTICE_PRIORITIES, priority),
      })
    );
  }
  if (pinned) head.push(el("span", { className: "pill pill-pinned", text: "Pinned" }));

  const meta = [
    el("span", {
      className: "notice-category",
      text: labelFor(NOTICE_CATEGORIES, notice.category ?? "general"),
    }),
    dot(),
    el("span", { text: relativeTime(notice.created_at) }),
  ];

  if (notice.created_by) {
    meta.push(dot(), el("span", { text: notice.created_by }));
  }
  if (actions.length) {
    meta.push(el("div", { className: "notice-actions" }, actions));
  }

  return el("article", { className: classes.join(" ") }, [
    el("div", { className: "notice-head" }, head),
    el("p", { className: "notice-body", text: notice.body }),
    el("div", { className: "notice-meta" }, meta),
  ]);
}
