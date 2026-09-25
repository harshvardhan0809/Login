/**
 * The dialog that stands between a student and a test.
 *
 * A web page cannot tell whether Safe Exam Browser is installed — browsers
 * deliberately do not expose that. So rather than guess, the dialog offers
 * both paths and lets the student pick: download it, or launch the exam in it.
 *
 * When the page is already running inside SEB, the dialog is skipped entirely
 * and the exam opens directly.
 */
import { el, openModal, toast } from "./ui.js";
import { examPageUrl, isRunningInSeb, sebLaunchUrl } from "./seb.js";
import { formatDateTime, formatDuration } from "./dates.js";
import { penaltySentence } from "./marking.js";

const SEB_DOWNLOAD_PAGE = "https://safeexambrowser.org/download_en.html";

/** Best guess at the student's platform, only used to label the download. */
function platformName() {
  const ua = navigator.userAgent ?? "";
  if (/Windows/i.test(ua)) return "Windows";
  if (/iPad|iPhone|iPod/i.test(ua)) return "iOS";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macOS";
  if (/Android/i.test(ua)) return "Android";
  return null;
}

/** Platforms with no official SEB build, where the student must switch device. */
const UNSUPPORTED = new Set(["Android"]);

function paragraph(text, className = "modal-text") {
  return el("p", { className, text });
}

/**
 * Shows the pre-test gate.
 *
 * @param {object} test A row from `tests`.
 * @returns {Promise<"launched"|"download"|"opened"|"cancelled">}
 */
export async function openSebGate(test) {
  // Already inside SEB: nothing to install, nothing to explain.
  if (isRunningInSeb()) {
    location.href = examPageUrl(test.id);
    return "opened";
  }

  const launchUrl = sebLaunchUrl(test.seb_config_url);
  const platform = platformName();
  const unsupported = platform && UNSUPPORTED.has(platform);

  const body = [
    paragraph(
      `"${test.title}" must be taken in Safe Exam Browser, a locked-down browser ` +
        "that prevents other apps, tabs and copy-paste during the exam."
    ),
  ];

  // Everything below is the part students most often get wrong: they start a
  // timed paper without realising the clock cannot be paused.
  const rules = [];
  if (test.duration_minutes) {
    rules.push(
      `You get ${formatDuration(test.duration_minutes)} from the moment the exam opens. ` +
        "The clock keeps running if you close the window, so start only when you are ready."
    );
  }
  if (test.closes_at) {
    rules.push(`This test closes at ${formatDateTime(test.closes_at)}.`);
  }
  const penalty = penaltySentence(test.negative_marking);
  if (penalty) rules.push(penalty);
  rules.push(
    "You cannot leave Safe Exam Browser until you submit — it needs a password your " +
      "teacher holds. It closes by itself a few seconds after you submit."
  );

  body.push(
    el(
      "ul",
      { className: "modal-rules" },
      rules.map(rule => el("li", { text: rule }))
    )
  );

  if (unsupported) {
    body.push(
      paragraph(
        `Safe Exam Browser has no official ${platform} build. Please use a ` +
          "Windows, macOS or iOS device for this test.",
        "modal-text modal-warning"
      )
    );
  }

  if (!launchUrl) {
    body.push(
      paragraph(
        "This test has no Safe Exam Browser configuration yet, so it cannot be " +
          "launched. Please ask your teacher to add one.",
        "modal-text modal-warning"
      )
    );
  } else {
    body.push(
      paragraph(
        "Already installed? Choose Launch. Your browser will ask for permission " +
          "to open Safe Exam Browser — accept it.",
        "modal-hint"
      )
    );
  }

  const actions = [];

  if (launchUrl && !unsupported) {
    actions.push({
      label: "Launch in Safe Exam Browser",
      value: "launched",
      variant: "modal-primary",
      href: launchUrl,
    });
  }

  actions.push({
    label: platform ? `Download for ${platform}` : "Download Safe Exam Browser",
    value: "download",
    variant: "modal-secondary",
    href: SEB_DOWNLOAD_PAGE,
    target: "_blank",
  });

  actions.push({ label: "Cancel", value: "cancelled", variant: "modal-quiet" });

  const choice = await openModal({
    title: "Safe Exam Browser required",
    body,
    actions,
  });

  if (choice === "launched") {
    toast("Opening Safe Exam Browser. Allow the prompt if your browser asks.", "info");
  }
  if (choice === "download") {
    toast("Install Safe Exam Browser, then come back and choose Launch.", "info");
  }

  return choice ?? "cancelled";
}
