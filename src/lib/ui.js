/** Small DOM + feedback helpers shared by every page. */

/** Creates an element: el("h4", { className: "title", text: "Hi" }, [child]) */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  const { text, dataset, ...rest } = props;

  Object.assign(node, rest);
  if (text !== undefined) node.textContent = text;
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);

  return node;
}

let toastRegion;

function getToastRegion() {
  if (!toastRegion?.isConnected) {
    toastRegion = el("div", { className: "toast-region", role: "status" });
    toastRegion.setAttribute("aria-live", "polite");
    document.body.append(toastRegion);
  }
  return toastRegion;
}

/**
 * Shows a transient message. Replaces the blocking `alert()` calls, which
 * freeze the page and cannot be styled or announced properly.
 * @param {string} message
 * @param {"info"|"success"|"error"} [type]
 */
export function toast(message, type = "info") {
  const node = el("div", { className: `toast toast-${type}`, text: message });
  getToastRegion().append(node);

  const remove = () => {
    node.classList.add("toast-out");
    node.addEventListener("transitionend", () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 500);
  };

  setTimeout(remove, type === "error" ? 6000 : 3500);
  node.addEventListener("click", remove);
  return node;
}

/** Puts a button into a disabled "working" state; returns a reset function. */
export function setBusy(button, label = "Working...") {
  if (!button) return () => {};

  const original = button.innerHTML;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.replaceChildren(el("span", { className: "spinner" }), document.createTextNode(label));

  return () => {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.innerHTML = original;
  };
}

/** Replaces a list container's contents with a single status line. */
export function setNotice(container, message, type = "info") {
  container?.replaceChildren(el("p", { className: `notice notice-${type}`, text: message }));
}

/** Renders `items` into `container`, or a notice when the list is empty. */
export function renderList(container, items, renderItem, emptyMessage) {
  if (!container) return;

  if (!items.length) {
    setNotice(container, emptyMessage);
    return;
  }

  container.replaceChildren(...items.map(renderItem));
}

/** Simple pluralising counter: countLabel(1, "test") -> "1 test". */
export function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Turns a Supabase/JS error into something worth showing a user. */
export function errorMessage(error, fallback = "Something went wrong. Please try again.") {
  const message = typeof error === "string" ? error : error?.message;
  return message?.trim() || fallback;
}

/** Runs `handler` on click and on Enter for the given inputs. */
export function onSubmit(inputs, handler) {
  inputs.filter(Boolean).forEach(input => {
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        handler();
      }
    });
  });
}

/**
 * Wires a [role="tablist"] of [data-tab] buttons to #panel-<name> sections.
 * Keeps one panel visible at a time and supports arrow-key navigation.
 */
export function wireTabs(tablist) {
  if (!tablist) return;

  const tabs = [...tablist.querySelectorAll("[data-tab]")];
  const panelFor = tab => document.getElementById(`panel-${tab.dataset.tab}`);

  function select(tab) {
    tabs.forEach(other => {
      const active = other === tab;
      other.setAttribute("aria-selected", String(active));
      other.classList.toggle("tab-active", active);

      const panel = panelFor(other);
      if (!panel) return;

      panel.hidden = !active;
    });

    tab.focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", event => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      select(tabs[(index + step + tabs.length) % tabs.length]);
    });
  });

  const initial = tabs.find(tab => tab.getAttribute("aria-selected") === "true") ?? tabs[0];
  if (initial) select(initial);
}

/**
 * Opens a modal dialog and returns a promise resolving to the value of the
 * action the user chose (or null if they dismissed it).
 *
 * @param {object} options
 * @param {string} options.title
 * @param {Node[]} options.body
 * @param {{label: string, value: any, variant?: string, href?: string, keepOpen?: boolean}[]} options.actions
 */
export function openModal({ title, body = [], actions = [] }) {
  return new Promise(resolve => {
    let settled = false;

    const close = value => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      previouslyFocused?.focus?.();
      resolve(value);
    };

    const previouslyFocused = document.activeElement;

    const buttons = actions.map(action => {
      // An anchor is used for links so the OS handles custom schemes (seb://)
      // and so middle-click and "copy link" behave normally.
      const node = action.href
        ? el("a", {
            className: `modal-action ${action.variant ?? ""}`.trim(),
            href: action.href,
            target: action.target ?? "_self",
            rel: "noreferrer",
            text: action.label,
          })
        : el("button", {
            type: "button",
            className: `modal-action ${action.variant ?? ""}`.trim(),
            text: action.label,
          });

      node.addEventListener("click", () => {
        if (!action.keepOpen) close(action.value);
      });
      return node;
    });

    const dialog = el("div", { className: "modal", role: "dialog" }, [
      el("h2", { className: "modal-title", text: title }),
      el("div", { className: "modal-body" }, body),
      el("div", { className: "modal-actions" }, buttons),
    ]);
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", title);

    const backdrop = el("div", { className: "modal-backdrop" }, [dialog]);
    backdrop.addEventListener("click", event => {
      if (event.target === backdrop) close(null);
    });

    function onKey(event) {
      if (event.key === "Escape") close(null);
    }

    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    buttons[0]?.focus();
  });
}
