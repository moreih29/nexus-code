import { useBrowserSuspendStore } from "../../state/stores/browser-suspend";

const TOAST_VIEWPORT_ATTR = "data-toast-viewport";

const OVERLAY_SELECTOR = `[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper],[${TOAST_VIEWPORT_ATTR}]`;

const MONACO_WIDGET_SELECTOR = ".monaco-editor,.editor-widget";

const INERT_SUBTREE_SELECTOR = "[inert]";

export function isOccludingOverlay(el: Element): boolean {
  if (el.matches(MONACO_WIDGET_SELECTOR) || el.closest(MONACO_WIDGET_SELECTOR) !== null) {
    return false;
  }
  if (el.getAttribute("aria-hidden") === "true") {
    return false;
  }
  if (el.closest(INERT_SUBTREE_SELECTOR) !== null) {
    return false;
  }
  return true;
}

const POPPER_WRAPPER_ATTR = "data-radix-popper-content-wrapper";

const BROWSER_SLOT_SELECTOR = "[data-browser-placeholder],[data-browser-devtools-placeholder]";

export function overlapsBrowserView(el: Element, slots: Iterable<Element>): boolean | "unplaced" {
  if ((el as HTMLElement).style?.transform.includes("-200%")) return "unplaced";
  const r = el.getBoundingClientRect();
  for (const slot of slots) {
    if (slot.closest(INERT_SUBTREE_SELECTOR) !== null) continue;
    const s = slot.getBoundingClientRect();
    if (s.width === 0 || s.height === 0) continue;
    if (r.left < s.right && r.right > s.left && r.top < s.bottom && r.bottom > s.top) return true;
  }
  return false;
}

function suspendsOnlyOverBrowser(el: Element): boolean {
  if (el.hasAttribute(TOAST_VIEWPORT_ATTR)) return true;
  return el.hasAttribute(POPPER_WRAPPER_ATTR) && el.querySelector('[role="tooltip"]') !== null;
}

const TOOLTIP_PLACEMENT_FRAMES = 10;

let installed = false;

export function initBrowserOverlayAutoSuspend(): void {
  if (installed) return;
  installed = true;

  let release: (() => void) | null = null;
  let pending = false;
  let placementFramesLeft = TOOLTIP_PLACEMENT_FRAMES;

  function check(): void {
    pending = false;
    let unplacedTooltip = false;
    const hasOverlay = Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some((el) => {
      if (!isOccludingOverlay(el)) return false;
      if (!suspendsOnlyOverBrowser(el)) return true;
      const overlap = overlapsBrowserView(el, document.querySelectorAll(BROWSER_SLOT_SELECTOR));
      if (overlap === "unplaced") unplacedTooltip = true;
      return overlap === true;
    });
    if (unplacedTooltip && placementFramesLeft > 0) {
      placementFramesLeft--;
      requestAnimationFrame(schedule);
    }
    if (hasOverlay && release === null) {
      release = useBrowserSuspendStore.getState().claim({ captureSnapshot: true });
    } else if (!hasOverlay && release !== null) {
      release();
      release = null;
    }
  }

  function schedule(): void {
    if (pending) return;
    pending = true;
    queueMicrotask(check);
  }

  const observer = new MutationObserver(() => {
    placementFramesLeft = TOOLTIP_PLACEMENT_FRAMES;
    schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["inert"],
  });

  window.addEventListener("focus", schedule);
  document.addEventListener("visibilitychange", schedule);

  check();
}
