/**
 * The flag a teacher sees on a result that was not demonstrably taken in Safe
 * Exam Browser.
 *
 * Two signals, deliberately weighted differently:
 *
 *   via_seb  The server saw SEB's mark in the request's user agent. Students
 *            are refused without it, so `false` on a protected test in
 *            practice means a teacher sat it, or protection was switched off
 *            and back on around the attempt.
 *   seb_api  The exam page itself found SEB's JavaScript API. Someone who
 *            fakes the user agent passes the first check but not this one.
 *
 * NULL means "not recorded" — manual marks, and anything from before these
 * checks existed — and is never flagged. An absence of evidence is not an
 * accusation.
 */
import { el } from "./ui.js";

/**
 * @param {{requiresSeb?: boolean, viaSeb?: boolean|null, sebApi?: boolean|null}} result
 * @returns {HTMLElement|null}
 */
export function sebBadge({ requiresSeb, viaSeb, sebApi }) {
  if (!requiresSeb) return null;

  if (viaSeb === false) {
    return el("span", {
      className: "pill pill-closed",
      text: "Not in SEB",
      title: "This attempt did not come from Safe Exam Browser.",
    });
  }

  if (viaSeb === true && sebApi === false) {
    return el("span", {
      className: "pill pill-high",
      text: "SEB unconfirmed",
      title:
        "The browser identified itself as Safe Exam Browser, but the exam page could not " +
        "find SEB's own JavaScript API. That points to a faked browser identity — or an " +
        "SEB version too old to provide the API.",
    });
  }

  return null;
}
