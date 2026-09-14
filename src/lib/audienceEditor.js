/**
 * Choosing who a test is for.
 *
 * Takes over the Tests panel the way the question editor does, because
 * picking from a class of thirty needs the full width and a search box — a
 * dropdown of checkboxes would be unusable by the second term.
 *
 * Everything here is convenience. The rule is enforced by the RLS policy on
 * `tests` and again inside get_exam(); this only decides what gets written to
 * test_audience.
 */
import { supabase } from "./supabase.js";
import { countLabel, el, errorMessage, setBusy, setNotice, toast } from "./ui.js";

/** Migration 0014 has not been run yet. */
export function isMissingAudience(error) {
  return (
    error?.code === "PGRST205" ||
    error?.code === "42P01" ||
    error?.code === "42703" ||
    /test_audience|audience/i.test(error?.message ?? "")
  );
}

/**
 * @param {HTMLElement} container Taken over until onBack is pressed.
 * @param {object} test Row from `tests`.
 * @param {Function} onBack
 */
export function openAudienceEditor(container, test, onBack) {
  /** Emails currently ticked. Held as a Set so search does not lose them. */
  const chosen = new Set();
  let students = [];

  const everyoneRadio = el("input", { type: "radio", name: "audience-mode", value: "all" });
  const selectedRadio = el("input", { type: "radio", name: "audience-mode", value: "selected" });

  const search = el("input", { type: "search", placeholder: "Filter by email" });
  const listBox = el("div", { className: "audience-list" });
  const summary = el("p", { className: "hint" });
  const pickerBox = el("div", { className: "audience-picker" });

  const saveBtn = el("button", { type: "button", text: "Save audience" });
  const backBtn = el("button", { type: "button", className: "secondary", text: "Back to tests" });

  function mode() {
    return selectedRadio.checked ? "selected" : "all";
  }

  function syncMode() {
    pickerBox.hidden = mode() !== "selected";
    summary.textContent =
      mode() === "all"
        ? "Everyone who signs in can see this test."
        : `${countLabel(chosen.size, "student")} selected.` +
          (chosen.size ? "" : " Nobody can see this test until you pick someone.");
  }

  function studentRow(student) {
    const box = el("input", { type: "checkbox", checked: chosen.has(student.email) });

    box.addEventListener("change", () => {
      box.checked ? chosen.add(student.email) : chosen.delete(student.email);
      syncMode();
    });

    return el("label", { className: "audience-row" }, [
      box,
      el("span", { className: "audience-email", text: student.email }),
      ...(student.role === "admin"
        ? [el("span", { className: "pill pill-live", text: "Teacher" })]
        : []),
    ]);
  }

  function renderList() {
    const term = search.value.trim().toLowerCase();
    const shown = term
      ? students.filter(student => student.email.toLowerCase().includes(term))
      : students;

    if (!shown.length) {
      setNotice(listBox, term ? "Nobody matches that search." : "No students have signed up yet.");
      return;
    }
    listBox.replaceChildren(...shown.map(studentRow));
  }

  // Select-all acts on what the search is showing, which is what makes it
  // useful — "tick everyone in 10B" rather than "tick the whole school".
  const allBtn = el("button", { type: "button", className: "edit-btn", text: "Select shown" });
  const noneBtn = el("button", { type: "button", className: "edit-btn", text: "Clear all" });

  allBtn.addEventListener("click", () => {
    const term = search.value.trim().toLowerCase();
    for (const student of students) {
      if (!term || student.email.toLowerCase().includes(term)) chosen.add(student.email);
    }
    renderList();
    syncMode();
  });

  noneBtn.addEventListener("click", () => {
    chosen.clear();
    renderList();
    syncMode();
  });

  search.addEventListener("input", renderList);
  everyoneRadio.addEventListener("change", syncMode);
  selectedRadio.addEventListener("change", syncMode);

  saveBtn.addEventListener("click", async () => {
    if (mode() === "selected" && !chosen.size) {
      toast("Pick at least one student, or choose Everyone.", "error");
      return;
    }

    const reset = setBusy(saveBtn, "Saving...");

    try {
      const { error: modeError } = await supabase
        .from("tests")
        .update({ audience: mode() })
        .eq("id", test.id);
      if (modeError) throw modeError;

      // Replaced wholesale rather than diffed: the list is small, and a diff
      // that goes wrong silently gives somebody access they should not have.
      const { error: clearError } = await supabase
        .from("test_audience")
        .delete()
        .eq("test_id", test.id);
      if (clearError) throw clearError;

      if (chosen.size) {
        const { error: insertError } = await supabase
          .from("test_audience")
          .insert([...chosen].map(email => ({ test_id: test.id, email })));
        if (insertError) throw insertError;
      }

      toast(
        mode() === "all"
          ? "This test is now available to everyone."
          : `This test is now limited to ${countLabel(chosen.size, "student")}.`,
        "success"
      );
      onBack();
    } catch (err) {
      console.error("Save audience failed:", err);
      toast(
        isMissingAudience(err)
          ? "Run supabase/migrations/0014_test_audience.sql to enable this."
          : errorMessage(err, "Could not save the audience."),
        "error"
      );
      reset();
    }
  });

  backBtn.addEventListener("click", onBack);

  pickerBox.append(
    el("div", { className: "audience-toolbar" }, [search, allBtn, noneBtn]),
    listBox
  );

  container.replaceChildren(
    el("div", { className: "section-title" }, [
      el("h2", { text: `Who can take — ${test.title}` }),
      backBtn,
    ]),
    el("div", { className: "panel-form" }, [
      el("label", { className: "checkbox-field" }, [
        everyoneRadio,
        el("span", { text: "Everyone" }),
      ]),
      el("label", { className: "checkbox-field" }, [
        selectedRadio,
        el("span", { text: "Only selected students" }),
      ]),
      summary,
      pickerBox,
      saveBtn,
    ])
  );

  (async () => {
    setNotice(listBox, "Loading students...");

    const [roll, assigned] = await Promise.all([
      supabase.from("users").select("email, role").order("email"),
      supabase.from("test_audience").select("email").eq("test_id", test.id),
    ]);

    if (roll.error) {
      setNotice(listBox, "Could not load the student list.", "error");
      console.error("Load roll failed:", roll.error.message);
      return;
    }

    // Missing only until 0014 has been run; an empty selection is correct then.
    if (assigned.error && !isMissingAudience(assigned.error)) {
      console.error("Load audience failed:", assigned.error.message);
    }

    students = roll.data ?? [];
    for (const row of assigned.data ?? []) chosen.add(row.email);

    // Reflects what is stored, so reopening the editor shows the current rule
    // rather than resetting it to the default.
    everyoneRadio.checked = (test.audience ?? "all") !== "selected";
    selectedRadio.checked = !everyoneRadio.checked;

    renderList();
    syncMode();
  })();
}
