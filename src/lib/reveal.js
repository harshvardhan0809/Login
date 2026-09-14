/**
 * Reveal-on-scroll.
 *
 * Cards start slightly low and transparent and settle into place as they come
 * into view. The point is to give a long dashboard a sense of depth as you
 * move through it, not to make anyone wait: the transition is half a second
 * and nothing is ever gated behind it.
 *
 * The hiding class is added from JavaScript, never from the markup. If this
 * module fails to load the page simply renders normally rather than staying
 * invisible forever — an animation is not worth a blank page.
 */

const HIDDEN = "reveal";
const SHOWN = "reveal-in";

/** Stagger between siblings, and the point past which it stops accumulating. */
const STAGGER_MS = 45;
const MAX_STEPS = 8;

let observer = null;

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function getObserver() {
  if (observer) return observer;

  observer = new IntersectionObserver(
    (entries, self) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add(SHOWN);
        // One reveal per element. Re-animating on every scroll past is the
        // thing that makes this pattern feel cheap.
        self.unobserve(entry.target);
      }
    },
    // Fires a little before the element is fully on screen, so it is settled
    // by the time the reader's eye arrives.
    { rootMargin: "0px 0px -6% 0px", threshold: 0.04 }
  );

  return observer;
}

/**
 * Registers elements to fade in as they scroll into view.
 *
 * Safe to call on every render: an element already revealed is left alone.
 *
 * @param {Iterable<Element>} nodes
 */
export function reveal(nodes) {
  const elements = [...(nodes ?? [])].filter(
    node => node?.nodeType === 1 && !node.classList.contains(SHOWN)
  );
  if (!elements.length) return;

  // No observer, or motion turned down: show everything at once.
  if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
    for (const element of elements) element.classList.add(HIDDEN, SHOWN);
    return;
  }

  elements.forEach((element, index) => {
    element.classList.add(HIDDEN);
    element.style.setProperty("--reveal-delay", `${Math.min(index, MAX_STEPS) * STAGGER_MS}ms`);
    getObserver().observe(element);
  });
}

/**
 * Reveals a page's fixed furniture — the parts that are in the markup rather
 * than rendered from data.
 */
export function revealPage(root = document) {
  reveal(root.querySelectorAll("[data-reveal]"));
}
