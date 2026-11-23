import { create } from "zustand";
import { createLogger } from "../../../../shared/log/renderer";
import type { PanelKind, ViewMode } from "../../../../shared/types/panel";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL } from "../../../../shared/types/panel";
import { canUseIpcBridge, ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { registerWorkspaceCleanup } from "../../workspace-cleanup";
import { cancelViewOptionsSave, scheduleViewOptionsSave } from "./io";

const log = createLogger("panel-view-options");

export interface PanelViewEntry {
  viewMode: ViewMode;
}

interface PanelViewOptionsState {
  entries: Map<string, PanelViewEntry>;
  loadViewOptions: (panelKind: PanelKind, workspaceId: string) => void;
  setViewMode: (panelKind: PanelKind, workspaceId: string, next: ViewMode) => void;
  closeForWorkspace: (workspaceId: string) => void;
}

const EMPTY_FALLBACKS: Record<PanelKind, Readonly<PanelViewEntry>> = {
  git: Object.freeze({ ...DEFAULT_VIEW_OPTIONS_BY_PANEL.git }),
  search: Object.freeze({ ...DEFAULT_VIEW_OPTIONS_BY_PANEL.search }),
};

function entryKey(panelKind: PanelKind, workspaceId: string): string {
  return `${panelKind}:${workspaceId}`;
}

export const usePanelViewOptionsStore = create<PanelViewOptionsState>((set, get) => ({
  entries: new Map(),

  loadViewOptions(panelKind, workspaceId) {
    const key = entryKey(panelKind, workspaceId);
    if (get().entries.has(key)) return;

    const defaults = { ...DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] };
    set((state) => {
      const next = new Map(state.entries);
      next.set(key, defaults);
      return { entries: next };
    });

    if (!canUseIpcBridge()) return;

    ipcCallResult("panel", "getViewOptions", { workspaceId, panelKind })
      .then((result) => {
        const opts = unwrapIpcResult(result);
        set((state) => {
          if (state.entries.get(key) !== defaults) return state;
          const next = new Map(state.entries);
          next.set(key, { viewMode: opts.viewMode });
          return { entries: next };
        });
      })
      .catch((error: unknown) => {
        log.error(`getViewOptions failed for ${panelKind}: ${(error as Error).message}`);
      });
  },

  setViewMode(panelKind, workspaceId, next) {
    const key = entryKey(panelKind, workspaceId);
    set((state) => {
      const cur = state.entries.get(key) ?? { ...DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] };
      const updated: PanelViewEntry = { ...cur, viewMode: next };
      const map = new Map(state.entries);
      map.set(key, updated);
      scheduleViewOptionsSave(panelKind, workspaceId, updated.viewMode);
      return { entries: map };
    });
  },

  closeForWorkspace(workspaceId) {
    cancelViewOptionsSave(workspaceId);
    set((state) => {
      const gitKey = entryKey("git", workspaceId);
      const searchKey = entryKey("search", workspaceId);
      if (!state.entries.has(gitKey) && !state.entries.has(searchKey)) return state;
      const entries = new Map(state.entries);
      entries.delete(gitKey);
      entries.delete(searchKey);
      return { entries };
    });
  },
}));

registerWorkspaceCleanup((workspaceId) => {
  usePanelViewOptionsStore.getState().closeForWorkspace(workspaceId);
});

export function useViewOptions(panelKind: PanelKind, workspaceId: string): PanelViewEntry {
  return usePanelViewOptionsStore(
    (s) => s.entries.get(entryKey(panelKind, workspaceId)) ?? EMPTY_FALLBACKS[panelKind],
  );
}
