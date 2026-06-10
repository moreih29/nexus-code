/**
 * Global MutationObserver that auto-suspends embedded browser views whenever
 * a DOM-based overlay (modal dialog / dropdown / context menu / popover) is
 * present on the page.
 *
 * WHY A GLOBAL OBSERVER
 * ---------------------
 * Per-component `useBrowserSuspendWhile(open)` hooks worked for our own
 * wrapped Radix components (Dialog / DropdownMenuRoot / ContextMenuRoot),
 * but silently missed any callsite that wires `RadixDialog.Root` directly —
 * the Settings dialog being the first such case to surface in practice.
 * Centralising the suspend trigger to a DOM observation means EVERY Radix
 * overlay (whether wrapped or not) automatically participates: when a portal
 * element matching the well-known Radix attributes appears in the body, we
 * claim; when the last one disappears, we release.
 *
 * SELECTORS
 * ---------
 * Radix tags every portal-mounted overlay with a stable role/attribute:
 *   [role="dialog"]                      — Dialog.Content
 *   [role="alertdialog"]                 — AlertDialog.Content
 *   [role="menu"]                        — DropdownMenu.Content, ContextMenu.Content
 *   [data-radix-popper-content-wrapper]  — Popover, Tooltip popper containers
 * Watching these four covers every overlay primitive Radix ships.
 *
 * FALSE POSITIVES — MONACO WIDGETS
 * --------------------------------
 * The role-based half of the selector also matches Monaco's own editor
 * widgets: the Find/Replace widget is `.editor-widget.find-widget[role="dialog"]`,
 * the context menu is `[role="menu"]`, the suggest widget likewise. Monaco
 * creates these lazily (first Cmd+F etc.) and then leaves them in the DOM
 * PERMANENTLY in a hidden state (`aria-hidden="true"`) rather than unmounting.
 * They live inside `.monaco-editor` and never occlude the browser
 * WebContentsView — they are part of the editor pane, not a portal over it.
 *
 * Without filtering, the first Find in any editor leaves a permanent
 * `[role="dialog"]` node behind, so `check()` reads `hasOverlay === true`
 * forever, holds the suspend claim, and the browser tab in that workspace
 * stays blank until a manual `resumeAll` or restart. `isOccludingOverlay()`
 * excludes Monaco widgets (whole `.monaco-editor` subtree + the `editor-widget`
 * class, in case overflow widgets are mounted outside it) and any
 * `aria-hidden="true"` node, leaving only genuine on-screen portal overlays.
 *
 * COALESCING
 * ----------
 * MutationObserver can fire many times per render — the check is scheduled
 * via `queueMicrotask` so multiple mutations in the same tick collapse into
 * a single `querySelector` + claim/release transition.
 *
 * DRAG IS HANDLED SEPARATELY
 * --------------------------
 * Drag operations have no DOM marker — there is no Radix portal added when
 * a `dragstart` fires.  `use-drag-source.ts` claims the suspend slot
 * explicitly in its React `onDragStart` handler with
 * `captureSnapshot: false`, and the matching release is wired both to the
 * document `dragend` and to the source component's unmount.  This module
 * does not interfere with that path; the two claim sources stack via the
 * normal refcount in `useBrowserSuspendStore`.
 */

import { useBrowserSuspendStore } from "../stores/browser-suspend";

const OVERLAY_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper]';

// Monaco editor widgets (find/replace, context menu, suggest) carry overlay
// roles but live inside the editor pane and persist in the DOM while hidden.
// Excluding the editor subtree (and the widget class, in case overflow widgets
// are mounted at the body) keeps them from registering as page overlays.
const MONACO_WIDGET_SELECTOR = ".monaco-editor,.editor-widget";

/**
 * True when `el` is a portal overlay that actually occludes the browser view.
 *
 * Excludes (a) Monaco editor widgets — same overlay roles, but part of the
 * editor pane, not a portal over the browser, and left in the DOM permanently
 * once created; and (b) `aria-hidden="true"` nodes — a closed/inert overlay
 * does not occlude anything (Radix marks BACKGROUND content aria-hidden, never
 * the live overlay content, so this never drops a real overlay).
 */
export function isOccludingOverlay(el: Element): boolean {
  if (el.matches(MONACO_WIDGET_SELECTOR) || el.closest(MONACO_WIDGET_SELECTOR) !== null) {
    return false;
  }
  if (el.getAttribute("aria-hidden") === "true") {
    return false;
  }
  return true;
}

let installed = false;

/**
 * Install the document-body MutationObserver and run the initial check.
 *
 * Safe to call only once during app bootstrap.  Calling a second time is a
 * no-op (returns silently); the renderer never tears down this observer
 * during its lifetime.
 */
export function initBrowserOverlayAutoSuspend(): void {
  if (installed) return;
  installed = true;

  // The release callback for the currently-held claim, if any.  `null` means
  // no claim is active — the DOM has no overlay.
  let release: (() => void) | null = null;
  // Coalescing flag: when a mutation arrives we schedule a single
  // `check()` for the next microtask and ignore further mutations until it
  // runs.  Prevents querySelector storms when Radix mounts/unmounts a
  // multi-node portal subtree in one go.
  let pending = false;

  function check(): void {
    pending = false;
    const hasOverlay = Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some(
      isOccludingOverlay,
    );
    if (hasOverlay && release === null) {
      // Entering overlay state — claim with snapshot capture so the modal
      // renders above a still frame of the page rather than a blank area.
      release = useBrowserSuspendStore.getState().claim({ captureSnapshot: true });
    } else if (!hasOverlay && release !== null) {
      // No overlay left — release so resumeAll fires and the live view
      // becomes visible again.
      release();
      release = null;
    }
  }

  function schedule(): void {
    if (pending) return;
    pending = true;
    queueMicrotask(check);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });

  // Re-reconcile on focus / tab-visibility regain. A MutationObserver only
  // fires on DOM changes, so a suspend state that desynced while the window
  // was backgrounded (e.g. the OS dropped a `dragend`, or the display slept
  // mid-overlay) would otherwise stay stuck until the next mutation. Coming
  // back to the window forces a fresh check, restoring the live view when no
  // overlay is actually present.
  window.addEventListener("focus", schedule);
  document.addEventListener("visibilitychange", schedule);

  // Initial sync — covers the (unlikely but harmless) case where an overlay
  // is already present at install time, e.g. an HMR reload while a modal is
  // open in development.
  check();
}
