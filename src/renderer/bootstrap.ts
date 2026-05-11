/**
 * App bootstrap sequences run once on mount. Extracted from App.tsx to
 * keep the component focused on rendering and workspace lifecycle.
 *
 * Functions here are plain async — callers own the `useEffect` wrapper.
 */

import type { WorkspaceMeta } from "../shared/types/workspace";
import { ipcCall } from "./ipc/client";
import { initializeWorkspaceLifecycle } from "./state/lifecycle/workspace-cleanup";
import { registerStatePersistence } from "./state/persistence";
import { useLayoutStore } from "./state/stores/layout";
import { useTabsStore } from "./state/stores/tabs";
import { useUIStore } from "./state/stores/ui";

/**
 * Hydrate persisted UI widths, layout snapshots, and tab records from
 * the main-process app-state store, then register the persistence
 * subscriber.
 *
 * Must be called once after the first render — Zustand `subscribe` fires
 * only on subsequent state changes, so the hydrate setStates have already
 * flushed synchronously by the time the subscriber is attached.
 */
export async function bootstrapAppState(): Promise<void> {
  // Install the central workspace:removed listener before any async I/O —
  // registered cleanup functions sit in memory regardless, but the listener
  // itself must be live before the first user-initiated workspace removal.
  initializeWorkspaceLifecycle();

  const state = await ipcCall("appState", "get", undefined);

  useUIStore.getState().hydrate({
    sidebarWidth: state.sidebarWidth,
    filesPanelWidth: state.filesPanelWidth,
  });

  if (state.layoutByWorkspace) {
    for (const [wsId, snap] of Object.entries(state.layoutByWorkspace)) {
      try {
        const tabsMap: Record<
          string,
          (typeof snap.tabs)[number] & { isPreview: boolean; isPinned: boolean }
        > = {};
        for (const t of snap.tabs) {
          const isPreview =
            "isPreview" in t && typeof t.isPreview === "boolean" ? t.isPreview : false;
          const isPinned = "isPinned" in t && typeof t.isPinned === "boolean" ? t.isPinned : false;
          tabsMap[t.id] = { ...t, isPreview, isPinned };
        }
        useTabsStore.setState((s) => ({
          byWorkspace: { ...s.byWorkspace, [wsId]: tabsMap },
        }));

        const knownTabIds = new Set(snap.tabs.map((t) => t.id));
        useLayoutStore
          .getState()
          .hydrate(wsId, { root: snap.root, activeGroupId: snap.activeGroupId }, knownTabIds);
      } catch {
        // Silent repair: skip invalid snapshot for this workspace
      }
    }
  }

  registerStatePersistence();
}

/**
 * Load the workspace list from main, push it into the store, and
 * activate the first workspace.
 */
export async function bootstrapWorkspaces(
  setAll: (list: WorkspaceMeta[]) => void,
  setActiveWorkspaceId: (id: string | null) => void,
): Promise<void> {
  const list = await ipcCall("workspace", "list", undefined);
  setAll(list);
  if (list.length > 0) {
    const first = list[0];
    setActiveWorkspaceId(first.id);
    ipcCall("workspace", "activate", { id: first.id }).catch(() => {});
  }
}
