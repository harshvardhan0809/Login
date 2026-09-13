/**
 * A confetti burst for the two moments worth marking: handing in an
 * assignment, and submitting a test.
 *
 * Self-contained and self-cleaning — it creates its own canvas, animates, and
 * removes itself. Nothing to mount, nothing to tear down, and no second canvas
 * if it is called twice in quick succession.
 *
 * Hand-rolled rather than a library: it is forty lines of physics against ~120
 * kB of dependency, and this has to load inside a locked-down browser on
 * whatever hardware an exam hall happens to own.
 */

const COLOURS = ["#5eead4", "#38bdf8", "#fbbf24", "#818cf8", "#f472b6", "#ffffff"];

/** Long enough to read as celebratory, short enough not to delay anything. */
const LIFETIME_MS = 2600;
const PIECES = 90;

/** Only ever one burst on screen. */
let active = null;

function makePiece(originX, originY) {
  // Fired upward and outward in a fan, so the shape reads as a burst rather
  // than a fountain. Speeds vary widely on purpose — uniform pieces look
  // mechanical.
  const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
  const speed = 7 + Math.random() * 9;

  return {
    x: originX,
    y: originY,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    width: 5 + Math.random() * 6,
    height: 8 + Math.random() * 7,
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.32,
    colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
    // A little wobble so pieces flutter instead of falling as rigid blocks.
    wobble: Math.random() * Math.PI * 2,
  };
}

/**
 * Fires the burst.
 *
 * @param {HTMLElement} [origin] Element to launch from; defaults to the middle
 *   of the viewport. Passing the result panel makes the confetti appear to
 *   come out of the score the student just earned.
 */
export function celebrate(origin) {
  // Someone who has asked the system to reduce motion has asked for exactly
  // this not to happen.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  active?.stop();

  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  canvas.setAttribute("aria-hidden", "true");

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  document.body.append(canvas);

  let originX = width / 2;
  let originY = height * 0.42;

  if (origin?.isConnected) {
    const box = origin.getBoundingClientRect();
    originX = box.left + box.width / 2;
    originY = box.top + box.height / 2;
  }

  const pieces = Array.from({ length: PIECES }, () => makePiece(originX, originY));
  const startedAt = performance.now();
  let frame = null;

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    canvas.remove();
    if (active?.canvas === canvas) active = null;
  }

  function draw(now) {
    const elapsed = now - startedAt;
    // Fade the whole burst out over its last third rather than letting pieces
    // vanish abruptly at the edge of the screen.
    const fade = Math.max(0, 1 - Math.max(0, elapsed - LIFETIME_MS * 0.6) / (LIFETIME_MS * 0.4));

    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = fade;

    for (const piece of pieces) {
      piece.vy += 0.32; // gravity
      piece.vx *= 0.995; // drag
      piece.wobble += 0.1;
      piece.x += piece.vx + Math.sin(piece.wobble) * 0.7;
      piece.y += piece.vy;
      piece.rotation += piece.spin;

      ctx.save();
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.rotation);
      ctx.fillStyle = piece.colour;
      // Scaling the height by the rotation fakes a piece turning edge-on,
      // which is most of what sells paper confetti.
      ctx.fillRect(
        -piece.width / 2,
        -piece.height / 2,
        piece.width,
        piece.height * Math.abs(Math.cos(piece.rotation))
      );
      ctx.restore();
    }

    if (elapsed >= LIFETIME_MS) {
      stop();
      return;
    }
    frame = requestAnimationFrame(draw);
  }

  active = { canvas, stop };
  frame = requestAnimationFrame(draw);
}
