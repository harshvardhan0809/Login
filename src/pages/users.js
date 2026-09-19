/**
 * Users and their records.
 *
 * Everything a teacher needs to put right by hand: adjust a mark, remove one,
 * clear a stuck attempt so a student can sit a test again, and see who is on
 * the system at all.
 *
 * Every write goes through a SECURITY DEFINER function rather than a table.
 * INSERT/UPDATE/DELETE on `results` are revoked from `authenticated` — which
 * an admin also is — and that revoke is exactly what stops a student ever
 * writing their own score. Keeping it means admin writes need their own
 * checked path, which is migration 0013.
 */
import { supabase } from "../lib/supabase.js";
import { requireAdmin, wireLogout } from "../lib/session.js";
import { countLabel, el, errorMessage, renderList, setBusy, setNotice, toast } from "../lib/ui.js";
import { formatDateTime, relativeTime } from "../lib/dates.js";
import { downloadCsv, toCsv } from "../lib/analytics.js";
import { sebBadge } from "../lib/sebBadge.js";

const statsEl = document.getElementById("userStats");
const searchEl = document.getElementById("userSearch");
const stateEl = document.getElementById("directoryState");
const tableEl = document.getElementById("userTable");
const countEl = document.getElementById("userCount");
const detailEl = document.getElementById("userDetail");
const exportBtn = document.getElementById("exportBtn");
const backBtn = document.getElementById("backBtn");

/** Counted as "active" if they have signed in within this many days. */
const ACTIVE_DAYS = 30;

const me = await requireAdmin();
wireLogout();
backBtn.addEventListener("click", () => location.replace("admin.html"));

let directory = [];
let tests = [];
let selected = null;

/** Migration 0013 has not been run, so none of the admin_* functions exist. */
function isMissingAdminApi(error) {
  return error?.code === "PGRST202" || /could not find the function/i.test(error?.message ?? "");
}

function fail(error, fallback) {
  console.error(fallback, error);
  toast(
    isMissingAdminApi(error)
      ? "Run supabase/migrations/0013_admin_user_management.sql to enable user management."
      : errorMessage(error, fallback),
    "error"
  );
}

function tile(value, label) {
  return el("div", { className: "stat-box" }, [
    el("p", { className: "stat-value", text: String(value) }),
    el("p", { text: label }),
  ]);
}

function renderStats() {
  const admins = directory.filter(user => user.role === "admin").length;
  const cutoff = Date.now() - ACTIVE_DAYS * 86400000;
  const active = directory.filter(
    user => user.last_sign_in_at && new Date(user.last_sign_in_at) >= cutoff
  ).length;

  statsEl.replaceChildren(
    tile(directory.length, "Users"),
    tile(directory.length - admins, "Students"),
    tile(admins, "Teachers"),
    tile(active, `Active in ${ACTIVE_DAYS} days`)
  );
}

// --- the directory ---------------------------------------------------------

function matching() {
  const term = (searchEl.value ?? "").trim().toLowerCase();
  if (!term) return directory;

  return directory.filter(user => `${user.email} ${user.role}`.toLowerCase().includes(term));
}

function userRow(user) {
  const row = el("tr", { className: selected === user.email ? "row-selected" : "" }, [
    el("td", { className: "cell-email", text: user.email }),
    el("td", {}, [
      el("span", {
        className: `pill ${user.role === "admin" ? "pill-live" : "pill-draft"}`,
        text: user.role === "admin" ? "Teacher" : "Student",
      }),
    ]),
    el("td", { className: "cell-num", text: String(user.attempts ?? 0) }),
    el("td", { className: "cell-num", text: user.average === null ? "—" : `${user.average}%` }),
    el("td", { className: "cell-num", text: String(user.submissions ?? 0) }),
    el("td", { className: "cell-date", text: relativeTime(user.last_sign_in_at) || "never" }),
    el("td", { className: "cell-date", text: formatDateTime(user.joined_at) }),
  ]);

  row.addEventListener("click", () => openUser(user.email));
  return row;
}

function renderDirectory() {
  const rows = matching();
  countEl.textContent = countLabel(rows.length, "user");

  if (!rows.length) {
    setNotice(tableEl, searchEl.value.trim() ? "No users match that search." : "Nobody yet.");
    return;
  }

  tableEl.replaceChildren(
    el("table", { className: "data-table data-table-rows" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Email" }),
          el("th", { text: "Role" }),
          el("th", { className: "cell-num", text: "Attempts" }),
          el("th", { className: "cell-num", text: "Average" }),
          el("th", { className: "cell-num", text: "Hand-ins" }),
          el("th", { text: "Last seen" }),
          el("th", { text: "Joined" }),
        ]),
      ]),
      el("tbody", {}, rows.map(userRow)),
    ])
  );
}

// --- one student's records -------------------------------------------------

/** The inline editor for a single mark. Used for both new and existing marks. */
function scoreForm(email, { testId = "", score = "", total = "", note = "" } = {}, onDone) {
  const testSelect = el(
    "select",
    {},
    tests.map(test => el("option", { value: test.id, text: `${test.title} — ${test.subject}` }))
  );
  if (testId) testSelect.value = testId;
  testSelect.disabled = Boolean(testId);

  const scoreInput = el("input", { type: "number", min: "0", step: "0.5", value: String(score) });
  const totalInput = el("input", { type: "number", min: "0.5", step: "0.5", value: String(total) });
  const noteInput = el("input", {
    type: "text",
    value: note ?? "",
    placeholder: "Why this mark was set by hand",
  });

  const saveBtn = el("button", { type: "button", text: "Save mark" });
  const cancelBtn = el("button", { type: "button", className: "secondary", text: "Cancel" });

  saveBtn.addEventListener("click", async () => {
    const reset = setBusy(saveBtn, "Saving...");

    const { error } = await supabase.rpc("admin_set_result", {
      p_test_id: testSelect.value,
      p_email: email,
      p_score: Number(scoreInput.value),
      p_total: Number(totalInput.value),
      p_note: noteInput.value.trim() || null,
    });
    reset();

    if (error) return fail(error, "Could not save that mark.");

    toast("Mark saved.", "success");
    await onDone();
  });

  cancelBtn.addEventListener("click", onDone);

  return el("div", { className: "panel-form score-form" }, [
    el("div", { className: "form-stack" }, [
      el("div", { className: "field" }, [el("label", { text: "Test" }), testSelect]),
      el("div", { className: "field" }, [el("label", { text: "Score" }), scoreInput]),
      el("div", { className: "field" }, [el("label", { text: "Out of" }), totalInput]),
      el("div", { className: "field" }, [
        el("label", { text: "Note" }),
        noteInput,
        el("small", {
          className: "hint",
          // An overridden mark with no reason attached is indistinguishable
          // from a mistake six months later.
          text: "Recorded against your name, and shown wherever this mark appears.",
        }),
      ]),
    ]),
    el("div", { className: "submission-actions" }, [saveBtn, cancelBtn]),
  ]);
}

function resultRow(email, result, reload) {
  const meta = [
    el("span", { text: formatDateTime(result.attempted_at) }),
    el("span", { className: "dot" }),
    el("span", { text: `${result.score}/${result.total}` }),
  ];

  if (result.adjusted_by) {
    meta.push(
      el("span", { className: "dot" }),
      el("span", {
        className: "adjusted-note",
        text: `set by ${result.adjusted_by}${result.adjustment_note ? ` — ${result.adjustment_note}` : ""}`,
      })
    );
  }

  const seb = sebBadge({
    requiresSeb: result.requires_seb,
    viaSeb: result.via_seb,
    sebApi: result.seb_api,
  });

  const editBtn = el("button", { type: "button", className: "edit-btn", text: "Edit mark" });
  const resetBtn = el("button", { type: "button", className: "edit-btn", text: "Allow retake" });
  const deleteBtn = el("button", { type: "button", className: "delete-btn", text: "Delete" });

  const card = el("article", { className: "record-row" }, [
    el("div", { className: "record-main" }, [
      el("div", { className: "test-title-row" }, [
        el("h4", { text: result.title ?? "Deleted test" }),
        ...(result.adjusted_by
          ? [el("span", { className: "pill pill-scheduled", text: "Adjusted" })]
          : []),
        ...(seb ? [seb] : []),
      ]),
      el("div", { className: "record-meta" }, meta),
    ]),
    el("div", { className: "score-badge", text: `${result.percentage}%` }),
    // A deleted test has no paper to retake and no test to re-mark against,
    // so the only thing left to do with its mark is remove it.
    el(
      "div",
      { className: "admin-actions" },
      result.test_id ? [editBtn, resetBtn, deleteBtn] : [deleteBtn]
    ),
  ]);

  editBtn.addEventListener("click", () => {
    card.replaceWith(
      scoreForm(
        email,
        {
          testId: result.test_id,
          score: result.score,
          total: result.total,
          note: result.adjustment_note ?? "",
        },
        reload
      )
    );
  });

  resetBtn.addEventListener("click", async () => {
    if (
      !confirm(
        `Let ${email} sit "${result.title ?? "this test"}" again?\n\n` +
          "Their mark and their attempt are both removed, so the test reappears on their dashboard."
      )
    ) {
      return;
    }

    const reset = setBusy(resetBtn, "Clearing...");
    const { error } = await supabase.rpc("admin_reset_attempt", {
      p_test_id: result.test_id,
      p_email: email,
    });
    reset();

    if (error) return fail(error, "Could not clear that attempt.");
    toast("Attempt cleared — they can sit it again.", "success");
    await reload();
  });

  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Delete this mark for ${email}? This cannot be undone.`)) return;

    const reset = setBusy(deleteBtn, "Deleting...");
    // By the mark's own id: a mark from a deleted test has no test_id, and
    // matching on (test_id, email) would find nothing.
    const { error } = result.id
      ? await supabase.rpc("admin_delete_result_by_id", { p_result_id: result.id })
      : result.test_id
        ? await supabase.rpc("admin_delete_result", { p_test_id: result.test_id, p_email: email })
        : {
            error: new Error(
              "Run supabase/migrations/0018_delete_orphaned_results.sql to delete marks from deleted tests."
            ),
          };
    reset();

    if (error) return fail(error, "Could not delete that mark.");
    toast("Mark deleted.", "success");
    await reload();
  });

  return card;
}

/** An attempt with no result: opened the paper, never submitted. */
function attemptRow(email, attempt, reload) {
  const resetBtn = el("button", { type: "button", className: "edit-btn", text: "Clear attempt" });

  resetBtn.addEventListener("click", async () => {
    if (!confirm(`Clear ${email}'s unfinished attempt at "${attempt.title ?? "this test"}"?`)) {
      return;
    }

    const reset = setBusy(resetBtn, "Clearing...");
    const { error } = await supabase.rpc("admin_reset_attempt", {
      p_test_id: attempt.test_id,
      p_email: email,
    });
    reset();

    if (error) return fail(error, "Could not clear that attempt.");
    toast("Attempt cleared.", "success");
    await reload();
  });

  return el("article", { className: "record-row" }, [
    el("div", { className: "record-main" }, [
      el("h4", { text: attempt.title ?? "Deleted test" }),
      el("div", { className: "record-meta" }, [
        el("span", { text: `Started ${formatDateTime(attempt.started_at)}` }),
        el("span", { className: "dot" }),
        el("span", { className: "mark-wrong", text: "never submitted" }),
      ]),
    ]),
    el("div", { className: "admin-actions" }, [resetBtn]),
  ]);
}

function submissionRow(submission) {
  return el("article", { className: "record-row" }, [
    el("div", { className: "record-main" }, [
      el("h4", { text: submission.title ?? "Deleted assignment" }),
      el("div", { className: "record-meta" }, [
        el("span", { text: relativeTime(submission.updated_at) }),
        ...(submission.note
          ? [el("span", { className: "dot" }), el("span", { text: submission.note })]
          : []),
      ]),
    ]),
    el("a", {
      className: "edit-btn",
      href: submission.link_url,
      target: "_blank",
      rel: "noreferrer",
      text: "Open work",
    }),
  ]);
}

function roleControl(user, reload) {
  // admin_set_role refuses this too, but an offered button that always fails
  // is worse than no button.
  if (user.email.toLowerCase() === (me?.email ?? "").toLowerCase()) {
    return el("span", { className: "hint", text: "This is you" });
  }

  const makeAdmin = user.role !== "admin";
  const button = el("button", {
    type: "button",
    className: makeAdmin ? "edit-btn" : "delete-btn",
    text: makeAdmin ? "Make teacher" : "Make student",
  });

  button.addEventListener("click", async () => {
    if (!confirm(`${makeAdmin ? "Give" : "Remove"} teacher access for ${user.email}?`)) return;

    const reset = setBusy(button, "Saving...");
    const { error } = await supabase.rpc("admin_set_role", {
      p_email: user.email,
      p_role: makeAdmin ? "admin" : "student",
    });
    reset();

    if (error) return fail(error, "Could not change that role.");

    toast(
      makeAdmin
        ? "Now a teacher. Add them to ADMIN_EMAILS in .env too, or the next sync will undo it."
        : "Now a student. Remove them from ADMIN_EMAILS in .env too.",
      "success"
    );
    await reload();
  });

  return button;
}

async function openUser(email) {
  selected = email;
  renderDirectory();

  detailEl.hidden = false;
  setNotice(detailEl, "Loading records...");
  detailEl.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const { data, error } = await supabase.rpc("admin_user_records", { p_email: email });
  if (error) {
    setNotice(detailEl, "Could not load that student's records.", "error");
    fail(error, "Could not load records.");
    return;
  }

  const user = directory.find(row => row.email === email) ?? { email, role: "student" };
  const reload = () => Promise.all([loadDirectory(), openUser(email)]);

  const results = data.results ?? [];
  const attempted = new Set(results.map(result => result.test_id));
  // Only attempts with no mark are interesting here; the rest are shown above
  // as results, with their own Allow-retake button.
  const unfinished = (data.attempts ?? []).filter(attempt => !attempted.has(attempt.test_id));
  const submissions = data.submissions ?? [];

  const addBtn = el("button", { type: "button", className: "edit-btn", text: "Add a mark" });
  const addMount = el("div", {});

  addBtn.addEventListener("click", () => {
    addMount.replaceChildren(scoreForm(email, {}, reload));
  });

  const closeBtn = el("button", { type: "button", className: "secondary", text: "Close" });
  closeBtn.addEventListener("click", () => {
    selected = null;
    detailEl.hidden = true;
    detailEl.replaceChildren();
    renderDirectory();
  });

  const purgeBtn = el("button", { type: "button", className: "delete-btn", text: "Clear records" });
  purgeBtn.addEventListener("click", async () => {
    if (
      !confirm(
        `Delete every mark, attempt and hand-in for ${email}?\n\n` +
          "This cannot be undone. Their login is not affected."
      )
    ) {
      return;
    }

    const reset = setBusy(purgeBtn, "Clearing...");
    const { data: removed, error: purgeError } = await supabase.rpc("admin_purge_user", {
      p_email: email,
    });
    reset();

    if (purgeError) return fail(purgeError, "Could not clear those records.");

    toast(
      `Cleared ${removed.results} mark(s), ${removed.attempts} attempt(s), ` +
        `${removed.submissions} hand-in(s).`,
      "success"
    );
    await reload();
  });

  const sections = [
    el("div", { className: "section-title" }, [
      el("h2", { text: email }),
      el("div", { className: "admin-actions" }, [
        addBtn,
        roleControl(user, reload),
        purgeBtn,
        closeBtn,
      ]),
    ]),
    addMount,
    el("div", { className: "section-title" }, [
      el("h3", { text: "Marks" }),
      el("span", { text: countLabel(results.length, "mark") }),
    ]),
  ];

  const resultList = el("div", {});
  renderList(resultList, results, result => resultRow(email, result, reload), "No marks yet.");
  sections.push(resultList);

  if (unfinished.length) {
    const attemptList = el("div", {});
    renderList(attemptList, unfinished, attempt => attemptRow(email, attempt, reload), "None.");
    sections.push(
      el("div", { className: "section-title" }, [
        el("h3", { text: "Unfinished attempts" }),
        el("span", { text: countLabel(unfinished.length, "attempt") }),
      ]),
      attemptList
    );
  }

  if (submissions.length) {
    const submissionList = el("div", {});
    renderList(submissionList, submissions, submissionRow, "None.");
    sections.push(
      el("div", { className: "section-title" }, [
        el("h3", { text: "Assignment hand-ins" }),
        el("span", { text: countLabel(submissions.length, "hand-in") }),
      ]),
      submissionList
    );
  }

  detailEl.replaceChildren(el("div", { className: "user-detail" }, sections));
}

// --- loading ---------------------------------------------------------------

function exportDirectory() {
  if (!directory.length) {
    toast("There is nobody to export yet.", "error");
    return;
  }

  const header = ["Email", "Role", "Attempts", "Average %", "Hand-ins", "Last seen", "Joined"];
  const rows = directory.map(user => [
    user.email,
    user.role,
    user.attempts ?? 0,
    user.average ?? "",
    user.submissions ?? 0,
    user.last_sign_in_at ? formatDateTime(user.last_sign_in_at) : "never",
    formatDateTime(user.joined_at),
  ]);

  downloadCsv("users.csv", toCsv([header, ...rows]));
  toast("CSV exported.", "success");
}

async function loadDirectory() {
  const { data, error } = await supabase.rpc("admin_user_directory");

  if (error) {
    setNotice(
      stateEl,
      isMissingAdminApi(error)
        ? "Run supabase/migrations/0013_admin_user_management.sql to enable user management."
        : "Could not load the user list.",
      "error"
    );
    return;
  }

  stateEl.replaceChildren();
  directory = data ?? [];
  renderStats();
  renderDirectory();
}

async function loadTests() {
  const { data, error } = await supabase
    .from("tests")
    .select("id, title, subject")
    .order("created_at", { ascending: false });

  if (error) console.error("Could not load tests:", error.message);
  tests = data ?? [];
}

searchEl.addEventListener("input", renderDirectory);
exportBtn.addEventListener("click", exportDirectory);

setNotice(stateEl, "Loading users...");
await Promise.all([loadDirectory(), loadTests()]);
