/**
 * Refcounted suspend handle for embedded browser views.
 *
 * WHY THIS STORE EXISTS
 * ----------------------
 * A `WebContentsView` (Electron 30+) is a native overlay that paints above
 * the renderer's DOM.  Anything that needs to render in front of it —
 * dropdown menus, modal dialogs, drag-to-split indicators — has to ask the
 * main process to detach the view for the duration of the overlay.
 *
 * Multiple overlays can be active at the same time (modal open + dropdown
 * within the modal, or dropdown + drag in flight).  Treating "is anything
 * occluding the browser right now?" as a refcount lets independent callers
 * claim and release without coordinating with each other.
 *
 * INVARIANTS
 * ----------
 * - `count` is always ≥ 0.
 * - A 0 → 1 transition fires `browser.suspendAll` exactly once.
 * - A 1 → 0 transition fires `browser.resumeAll` exactly once.
 * - Every `claim()` returns a `release()` function that is idempotent: calling
 *   it twice is harmless.  This matches React 18 strict-mode useEffect
 *   semantics where cleanup may run twice in development.
 *
 * The renderer holds the refcount on purpose — only the renderer knows about
 * dropdown / modal / drag lifetimes.  The main process sees a simple
 * suspended/not-suspended toggle.
 */

import { useEffect } from "react";
import { create } from "zustand";
import { ipcCallResult } from "@/ipc/client";

interface BrowserSuspendState {
  /** Number of currently active claims.  Exposed for debug introspection. */
  count: number;
  /**
   * Acquire one suspend claim.  Returns a `release` callback that drops it.
   *
   * Calling the returned `release` more than once is harmless — only the
   * first call decrements the counter.  Designed so React StrictMode's
   * double-invoked cleanup does not corrupt the count.
   */
  claim(): () => void;
}

export const useBrowserSuspendStore = create<BrowserSuspendState>((set, get) => ({
  count: 0,
  claim() {
    const next = get().count + 1;
    set({ count: next });
    if (next === 1) {
      // Edge transition 0 → 1 — main process detaches all active views.
      void ipcCallResult("browser", "suspendAll", {});
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const after = get().count - 1;
      // Clamp defensively: in case of any unexpected over-release the counter
      // never wraps to negative and resumeAll still fires correctly.
      set({ count: Math.max(0, after) });
      if (after <= 0) {
        // Edge transition 1 → 0 — main process re-attaches every active view
        // and re-applies the cached bounds so it lands where it was before.
        void ipcCallResult("browser", "resumeAll", {});
      }
    };
  },
}));

/**
 * Declarative wrapper around `useBrowserSuspendStore.claim()`.
 *
 * Holds a suspend claim for as long as `active` is `true`.  Releases the
 * claim automatically on unmount or when `active` transitions back to
 * `false`.  Designed so callers can write:
 *
 * ```tsx
 * const [open, setOpen] = useState(false);
 * useBrowserSuspendWhile(open);
 * ```
 *
 * and not think about IPC or refcount.
 */
export function useBrowserSuspendWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const release = useBrowserSuspendStore.getState().claim();
    return release;
  }, [active]);
}
