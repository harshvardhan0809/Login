/**
 * The flag a teacher sees on a result that was not demonstrably taken in Safe
 * Exam Browser.
 *
 * via_seb is whether the server saw SEB's mark in the request's user agent.
 * Students are refused without it, so `false` on a protected test in practice
 * means a teacher sat it, or protection was switched off and back on around
 * the attempt.
 *
 * seb_api (whether the page found window.SafeExamBrowser) is still recorded but
 * not flagged: genuine SEB attempts came back without the API, so its absence
 * proves nothing.
 *
 * NULL means "not recorded" — manual marks, and anything from before these
 * checks existed — and is never flagged. An absence of evidence is not an
 * accusation.
 */
import { el } from "./ui.js";

/**
 * @param {{requiresSeb?: boolean, viaSeb?: boolean|null}} result
 * @returns {HTMLElement|null}
 */
export function sebBadge({ requiresSeb, viaSeb }) {
  if (!requiresSeb) return null;

  if (viaSeb === false) {
    return el("span", {
      className: "pill pill-closed",
      text: "Not in SEB",
      title: "This attempt did not come from Safe Exam Browser.",
    });
  }

  return null;
}
