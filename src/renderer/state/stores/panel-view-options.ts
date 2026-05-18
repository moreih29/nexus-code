/**
 * Shared per-(workspace × panelKind) view options store.
 *
 * Both the git panel and the search panel need the same two view options
 * (viewMode, compactFolders) with the same IPC persistence semantics. This
 * store centralises that logic rather than duplicating it in each panel's
 * store.
 *
 * State shape:
 *   entries: Map<`${PanelKind}:${workspaceId}`, { viewMode; compactFolders }>
 *
 * Actions:
 *   loadViewOptions(panelKind, workspaceId) — seed from IPC; skips if loaded.
 *   setViewMode(panelKind, workspaceId, next) — update + debounced persist.
 *   setCompactFolders(panelKind, workspaceId, next) — update + debounced persist.
 *   closeForWorkspace(workspaceId) — cancel timers; keep entries.
 *
 * Selectors:
 *   useViewOptions(panelKind, workspaceId) — returns entry with stable EMPTY
 *     fallback per PanelKind (avoids React getSnapshot warning).
 *   usePanelViewOptionsStore — raw zustand store access.
 */

import { create } from "zustand";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL } from "../../../shared/types/panel";
import type { PanelKind, ViewMode } from "../../../shared/types/panel";
import { canUseIpcBridge, ipcCall } from "../../ipc/client";
import { cancelViewOptionsSave, scheduleViewOptionsSave } from "./panel-view-options-io";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelViewEntry {
  viewMode: ViewMode;
  compactFolders: boolean;
}

interface PanelViewOptionsState {
  entries: Map<string, PanelViewEntry>;
  loadViewOptions: (panelKind: PanelKind, workspaceId: string) => void;
  setViewMode: (panelKind: PanelKind, workspaceId: string, next: ViewMode) => void;
  setCompactFolders: (panelKind: PanelKind, workspaceId: string, next: boolean) => void;
  closeForWorkspace: (workspaceId: string) => void;
}

// ---------------------------------------------------------------------------
// Stable empty-fallback sentinels — one per PanelKind.
//
// Returning a fresh object from a useSyncExternalStore selector triggers
// React's "getSnapshot should be cached" warning and can cause infinite
// re-renders. We reuse frozen fallbacks per PanelKind so that consumers
// that haven't yet called loadViewOptions see a stable reference.
// ---------------------------------------------------------------------------

const EMPTY_FALLBACKS: Record<PanelKind, Readonly<PanelViewEntry>> = {
  git: Object.freeze({ ...DEFAULT_VIEW_OPTIONS_BY_PANEL.git }),
  search: Object.freeze({ ...DEFAULT_VIEW_OPTIONS_BY_PANEL.search }),
};

// ---------------------------------------------------------------------------
// Key helper
// ---------------------------------------------------------------------------

function entryKey(panelKind: PanelKind, workspaceId: string): string {
  return `${panelKind}:${workspaceId}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePanelViewOptionsStore = create<PanelViewOptionsState>((set, get) => ({
  entries: new Map(),

  loadViewOptions(panelKind, workspaceId) {
    const key = entryKey(panelKind, workspaceId);
    if (get().entries.has(key)) return;

    // Seed defaults immediately so components render without waiting for IPC.
    set((state) => {
      if (state.entries.has(key)) return state;
      const next = new Map(state.entries);
      next.set(key, { ...DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] });
      return { entries: next };
    });

    if (!canUseIpcBridge()) return;

    ipcCall("panel", "getViewOptions", { workspaceId, panelKind })
      .then((opts) => {
        set((state) => {
          const next = new Map(state.entries);
          next.set(key, {
            viewMode: opts.viewMode,
            compactFolders: opts.compactFolders,
          });
          return { entries: next };
        });
      })
      .catch((error: unknown) => {
        console.error(`[panel-view-options] getViewOptions failed for ${panelKind}`, error);
      });
  },

  setViewMode(panelKind, workspaceId, next) {
    const key = entryKey(panelKind, workspaceId);
    set((state) => {
      const cur = state.entries.get(key) ?? { ...DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] };
      const updated: PanelViewEntry = { ...cur, viewMode: next };
      const map = new Map(state.entries);
      map.set(key, updated);
      scheduleViewOptionsSave(panelKind, workspaceId, updated.viewMode, updated.compactFolders);
      return { entries: map };
    });
  },

  setCompactFolders(panelKind, workspaceId, next) {
    const key = entryKey(panelKind, workspaceId);
    set((state) => {
      const cur = state.entries.get(key) ?? { ...DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] };
      const updated: PanelViewEntry = { ...cur, compactFolders: next };
      const map = new Map(state.entries);
      map.set(key, updated);
      scheduleViewOptionsSave(panelKind, workspaceId, updated.viewMode, updated.compactFolders);
      return { entries: map };
    });
  },

  closeForWorkspace(workspaceId) {
    // Cancel pending debounce timers; KEEP entries (persisted viewMode/compactFolders survive).
    cancelViewOptionsSave(workspaceId);
  },
}));

// ---------------------------------------------------------------------------
// Selector helper
// ---------------------------------------------------------------------------

/**
 * Subscribe to the view options for a (panelKind, workspaceId) pair.
 * Returns the per-panel stable EMPTY fallback when no entry exists yet
 * (before loadViewOptions has been called) so callers always get a valid
 * reference without needing to null-check.
 */
export function useViewOptions(panelKind: PanelKind, workspaceId: string): PanelViewEntry {
  return usePanelViewOptionsStore(
    (s) => s.entries.get(entryKey(panelKind, workspaceId)) ?? EMPTY_FALLBACKS[panelKind],
  );
}
