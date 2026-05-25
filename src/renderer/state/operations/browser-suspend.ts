/**
 * Global document-level drag listener that holds a browser-suspend claim for
 * the lifetime of any drag carrying one of our supported MIME types.
 *
 * WHY
 * ---
 * Without this, drag-to-split for a browser tab fails: the drop-target
 * listeners in `useDropTarget` are wired on DOM nodes, but the
 * WebContentsView is a native overlay that swallows dragover events in its
 * area before the DOM can see them.  Suspending the view for the duration of
 * the drag lets the DOM drop zones receive their events as expected.
 *
 * SCOPE
 * -----
 * Only drags with MIME_TAB or MIME_FILE in their dataTransfer types claim a
 * suspend slot — random OS-level drags (e.g. images from an external app)
 * don't trigger a costly suspend/resume cycle.
 *
 * Pairs `dragstart` with `dragend` so the lifecycle is deterministic.  Native
 * `dragend` fires even when the drop is cancelled (Esc pressed, dropped on a
 * non-target, dropped into another window), so the claim is always released.
 */

import { hasSupportedMime } from "@/components/workspace/dnd/payload";
import { useBrowserSuspendStore } from "@/state/stores/browser-suspend";

/**
 * Register the document-level dragstart/dragend listeners exactly once.
 * Safe to call from bootstrap — the listeners survive for the lifetime of
 * the renderer.
 */
export function initBrowserSuspendDragListener(): void {
  // The release callback returned by `claim()` while a drag is in flight.
  // We MUST hold a single reference: dragstart fires once per drag, and we
  // pair it with the next dragend on the document.
  let release: (() => void) | null = null;

  function onDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    if (!hasSupportedMime(e.dataTransfer.types)) return;

    // Defensive: if a prior dragend was somehow missed, release the stale
    // claim before opening a new one so the refcount stays accurate.
    release?.();
    release = useBrowserSuspendStore.getState().claim();
  }

  function onDragEnd() {
    release?.();
    release = null;
  }

  // Capture-phase dragstart so we run before any source's stopPropagation can
  // hide the event from us.  `dragend` always fires on the source element and
  // bubbles to document, so a bubble listener is sufficient — using capture
  // here would be no different.
  document.addEventListener("dragstart", onDragStart, { capture: true });
  document.addEventListener("dragend", onDragEnd);
}
