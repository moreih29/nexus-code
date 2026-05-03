/**
 * Persistence subscriber for layout + tabs state.
 *
 * Subscribes to both stores and debounces writes to appState via IPC.
 * Registration is deferred until after the boot hydrate completes so the
 * initial hydrate does not immediately trigger a write-storm.
 *
 * Usage (from App.tsx boot effect, once after hydrate):
 *   import { registerLayoutPersistence } from "./store/persistLayout";
 *   registerLayoutPersistence();
 */

import type { AppState } from "../../shared/types/appState";
import { ipcCall } from "../ipc/client";
import { useLayoutStore } from "./layout";
import type { Tab } from "./tabs";
import { useTabsStore } from "./tabs";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type LayoutSnapshot = NonNullable<AppState["layoutByWorkspace"]>[string];

function toSnapshot(workspaceId: string): LayoutSnapshot | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const tabRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};

  if (!layout) return null;

  const tabs: Tab[] = Object.values(tabRecord);
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

export function registerLayoutPersistence(): void {
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

    ipcCall("appState", "set", { layoutByWorkspace }).catch(() => {});
  }, 250);

  unsubLayout = useLayoutStore.subscribe(flush);
  unsubTabs = useTabsStore.subscribe(flush);
}

export function unregisterLayoutPersistence(): void {
  unsubLayout?.();
  unsubTabs?.();
  unsubLayout = null;
  unsubTabs = null;
}
