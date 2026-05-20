/**
 * App bootstrap sequences run once on mount. Extracted from App.tsx to
 * keep the component focused on rendering and workspace lifecycle.
 *
 * Functions here are plain async — callers own the `useEffect` wrapper.
 */

import type { LspLanguageId } from "../shared/types/app-state";
import type { WorkspaceMeta } from "../shared/types/workspace";
import { ipcCallResult, mustSucceed } from "./ipc/client";
import { registerStatePersistence } from "./state/persistence";
import { useEditorFontStore } from "./state/stores/editor-font";
import { useLayoutStore } from "./state/stores/layout";
import { useLspEnabledStore } from "./state/stores/lsp-enabled";
import { useTabsStore } from "./state/stores/tabs";
import { useTerminalStore } from "./state/stores/terminal";
import { useThemeStore } from "./state/stores/theme";
import { useUIStore } from "./state/stores/ui";
import { useWindowOpacityStore } from "./state/stores/window-opacity";
import { startNotificationClickListener } from "./state/notification-click";
import { initializeWorkspaceLifecycle } from "./state/workspace-cleanup";

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

  // Wire the OS notification click → workspace activate + tab reveal listener.
  startNotificationClickListener();

  // Bootstrap is an initialization path — no recovery possible if appState is unavailable.
  const state = mustSucceed(await ipcCallResult("appState", "get", undefined));

  useUIStore.getState().hydrate({
    sidebarWidth: state.sidebarWidth,
    filesPanelWidth: state.filesPanelWidth,
  });

  // Hydrate theme from appState (authoritative store).
  // This overwrites the localStorage-based initial value so the two stay in sync.
  useThemeStore.getState().hydrate(state.themePreference);

  // Hydrate editor font settings from appState (authoritative store).
  useEditorFontStore.getState().hydrate({
    size: state.editorFontSize,
    family: state.editorFontFamily,
    ligatures: state.editorFontLigatures,
    lineHeight: state.editorFontLineHeight,
  });

  // Hydrate terminal user settings from appState (authoritative store).
  useTerminalStore.getState().hydrate({
    fontSize: state.terminalFontSize,
    cursorStyle: state.terminalCursorStyle,
  });

  // Hydrate window opacity from appState (authoritative store).
  useWindowOpacityStore.getState().hydrate(state.windowOpacity);

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

  // Dev-only console helper for testing window transparency before a settings
  // UI exists. `__setWindowOpacity(0.5)` dual-writes localStorage + appState
  // (mirrors what a future settings control will call). The renderer surfaces
  // update live, but the OS window's `transparent` flag is fixed at
  // window-creation time — restart the app to see the window go transparent.
  if (import.meta.env?.DEV) {
    (window as unknown as { __setWindowOpacity?: (v: number) => void }).__setWindowOpacity = (
      v: number,
    ) => {
      useWindowOpacityStore.getState().setOpacity(v);
      console.info(`[dev] windowOpacity = ${v} — restart the app to apply the window flag.`);
    };
  }
}

/**
 * Load the workspace list from main, push it into the store, and
 * restore the active workspace selection.
 *
 * Does NOT call workspace:activate at startup. Main's init() is the source
 * of truth for the restored active workspace and its conditional auto-connect
 * (key-only SSH and local connect automatically; interactive SSH restores in
 * the disconnected state). Calling activate here would both trigger a
 * connection and wrongly bump the recency list on every app launch.
 */
export async function bootstrapWorkspaces(
  setAll: (list: WorkspaceMeta[]) => void,
  setActiveWorkspaceId: (id: string | null) => void,
): Promise<void> {
  // Bootstrap is an initialization path — no recovery possible if workspace list is unavailable.
  const list = mustSucceed(await ipcCallResult("workspace", "list", undefined));
  setAll(list);
  if (list.length > 0) {
    const first = list[0];
    setActiveWorkspaceId(first.id);
  }
}

/**
 * Hydrate the per-workspace LSP enabled-languages store for all known
 * workspaces. Must be called after `bootstrapWorkspaces` so the workspace
 * list is available, and before any `attachLspBridge` call that gates on
 * `isLspEnabledForWorkspace`.
 *
 * Queries main for each workspace's enabled list in parallel then bulk-loads
 * into the store in one shot so the sync getter sees a fully populated state
 * before any editor model fires its first didOpen.
 */
export async function bootstrapLspEnabled(workspaces: WorkspaceMeta[]): Promise<void> {
  if (workspaces.length === 0) return;

  const entries = await Promise.all(
    workspaces.map(async (ws) => {
      const result = await ipcCallResult("lsp", "getEnabledLanguages", { workspaceId: ws.id });
      if (!result.ok) return [ws.id, []] as const;
      return [ws.id, result.value.languages] as const;
    }),
  );

  const initial: Record<string, LspLanguageId[]> = {};
  for (const [wsId, langs] of entries) {
    initial[wsId] = langs as LspLanguageId[];
  }
  useLspEnabledStore.getState().hydrateAll(initial);
}
