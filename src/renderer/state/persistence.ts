/**
 * Persistence subscriber for renderer state.
 *
 * Subscribes to layout + tabs stores and debounces writes to appState via IPC.
 * Registration is deferred until after the boot hydrate completes so the
 * initial hydrate does not immediately trigger a write-storm.
 *
 * Usage (from App.tsx boot effect, once after hydrate):
 *   import { registerStatePersistence } from "./state/persistence";
 *   registerStatePersistence();
 */

import { STATE_PERSIST_DEBOUNCE_MS } from "../../shared/util/timing-constants";
import type { AppState } from "../../shared/types/app-state";
import { ipcCallResult } from "../ipc/client";
import { useLayoutStore } from "./stores/layout";
import { useTabsStore } from "./stores/tabs";

// Re-exported so existing callers (e.g. tests) can keep importing from this module.
export { STATE_PERSIST_DEBOUNCE_MS };

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type LayoutSnapshot = NonNullable<AppState["layoutByWorkspace"]>[string];

function toSnapshot(workspaceId: string): LayoutSnapshot | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const tabRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};

  if (!layout) return null;

  // Strip UntitledTab entries — they are session-only and must not be
  // restored on next boot (a new untitled index would be assigned instead).
  // BrowserTab and all other types are persisted as-is.
  const tabs = Object.values(tabRecord).filter(
    (t) => t.type !== "untitled",
  ) as LayoutSnapshot["tabs"];
  return {
    root: layout.root,
    activeGroupId: layout.activeGroupId,
    tabs,
  };
}

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let unsubLayout: (() => void) | null = null;
let unsubTabs: (() => void) | null = null;

export function registerStatePersistence(): void {
  // Only register once
  if (unsubLayout !== null) return;

  const flush = debounce(() => {
    const workspaceIds = Object.keys(useLayoutStore.getState().byWorkspace);
    const layoutByWorkspace: NonNullable<AppState["layoutByWorkspace"]> = {};

    for (const wsId of workspaceIds) {
      const snap = toSnapshot(wsId);
      if (snap) {
        layoutByWorkspace[wsId] = snap;
      }
    }

    // Fire-and-forget: layout persistence is best-effort; local state is source of truth.
    void ipcCallResult("appState", "set", { layoutByWorkspace }).then((result) => {
      if (!result.ok) console.warn("[persistence] appState set failed", result.message);
    });
  }, STATE_PERSIST_DEBOUNCE_MS);

  // Slice-scoped subscriptions: only re-flush when `byWorkspace` (the
  // serialised slice) actually changes reference. The bare `subscribe(fn)`
  // form fires for every store mutation — including non-persisted slots
  // a future store might add — and the resulting unconditional flush
  // would be wasted work even with the 250ms debounce. Implemented as
  // manual diffing so we don't have to drag in `subscribeWithSelector`
  // middleware for two callers.
  let prevLayout = useLayoutStore.getState().byWorkspace;
  let prevTabs = useTabsStore.getState().byWorkspace;
  unsubLayout = useLayoutStore.subscribe((state) => {
    if (state.byWorkspace !== prevLayout) {
      prevLayout = state.byWorkspace;
      flush();
    }
  });
  unsubTabs = useTabsStore.subscribe((state) => {
    if (state.byWorkspace !== prevTabs) {
      prevTabs = state.byWorkspace;
      flush();
    }
  });
}

export function unregisterStatePersistence(): void {
  unsubLayout?.();
  unsubTabs?.();
  unsubLayout = null;
  unsubTabs = null;
}
