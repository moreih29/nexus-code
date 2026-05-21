import { create } from "zustand";
import { ipcCallResult } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 240;

export const FILES_PANEL_WIDTH_MIN = 160;
export const FILES_PANEL_WIDTH_MAX = 600;
export const FILES_PANEL_WIDTH_DEFAULT = 240;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampSidebar(value: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value));
}

function clampFilesPanel(value: number): number {
  return Math.min(FILES_PANEL_WIDTH_MAX, Math.max(FILES_PANEL_WIDTH_MIN, value));
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface HydrateOpts {
  sidebarWidth?: number;
  filesPanelWidth?: number;
  sidebarHidden?: boolean;
  filesPanelHidden?: boolean;
}

export type FilesPanelMode = "tree" | "search" | "git";

export const FILES_PANEL_MODE_DEFAULT: FilesPanelMode = "tree";

interface UIState {
  sidebarWidth: number;
  filesPanelWidth: number;
  /**
   * Visibility flags for the two left-hand columns. `false` (visible) is
   * the default; the ⌘B / ⌘⇧B commands flip these. Widths persist
   * independently so re-opening restores the user's drag-set width.
   */
  sidebarHidden: boolean;
  filesPanelHidden: boolean;
  /** Per-workspace files-panel view mode. Missing entry → falls back to default. */
  filesPanelModes: Map<string, FilesPanelMode>;
  hydrate(opts: HydrateOpts): void;
  setSidebarWidth(width: number, persist?: boolean): void;
  setFilesPanelWidth(width: number, persist?: boolean): void;
  setFilesPanelMode(workspaceId: string, mode: FilesPanelMode): void;
  /** Toggle the Files Panel (tree/git/search column) visibility. Persists. */
  toggleFilesPanel(): void;
  /**
   * "Sidebar" in the VSCode sense — toggle both columns together. If
   * either is currently hidden, show both; otherwise hide both. Persists
   * both flags in one IPC write.
   */
  toggleSidebar(): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useUIStore = create<UIState>((set) => {
  // Drop workspace-keyed UI state when its workspace is removed, so a
  // future workspace reusing an id (or a stale entry sticking around in
  // memory) can't surface another workspace's view mode. The central
  // registry owns the IPC listener; here we only declare what to do.
  registerWorkspaceCleanup((id) => {
    set((state) => {
      if (!state.filesPanelModes.has(id)) return state;
      const next = new Map(state.filesPanelModes);
      next.delete(id);
      return { filesPanelModes: next };
    });
  });

  return {
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
    sidebarHidden: false,
    filesPanelHidden: false,
    filesPanelModes: new Map(),

    hydrate({ sidebarWidth, filesPanelWidth, sidebarHidden, filesPanelHidden }) {
      set({
        sidebarWidth:
          sidebarWidth !== undefined ? clampSidebar(sidebarWidth) : SIDEBAR_WIDTH_DEFAULT,
        filesPanelWidth:
          filesPanelWidth !== undefined
            ? clampFilesPanel(filesPanelWidth)
            : FILES_PANEL_WIDTH_DEFAULT,
        sidebarHidden: sidebarHidden ?? false,
        filesPanelHidden: filesPanelHidden ?? false,
      });
    },

    setSidebarWidth(width, persist) {
      const next = clampSidebar(width);
      set({ sidebarWidth: next });
      if (persist) {
        // Fire-and-forget: local state is source of truth; appState is the durable store.
        void ipcCallResult("appState", "set", { sidebarWidth: next }).then((result) => {
          if (!result.ok) console.warn("[ui] appState set failed", result.message);
        });
      }
    },

    setFilesPanelWidth(width, persist) {
      const next = clampFilesPanel(width);
      set({ filesPanelWidth: next });
      if (persist) {
        // Fire-and-forget: local state is source of truth; appState is the durable store.
        void ipcCallResult("appState", "set", { filesPanelWidth: next }).then((result) => {
          if (!result.ok) console.warn("[ui] appState set failed", result.message);
        });
      }
    },

    setFilesPanelMode(workspaceId, mode) {
      set((state) => {
        const cur = state.filesPanelModes.get(workspaceId) ?? FILES_PANEL_MODE_DEFAULT;
        if (cur === mode) return state;
        const next = new Map(state.filesPanelModes);
        next.set(workspaceId, mode);
        return { filesPanelModes: next };
      });
    },

    toggleFilesPanel() {
      let next = false;
      set((state) => {
        next = !state.filesPanelHidden;
        return { filesPanelHidden: next };
      });
      void ipcCallResult("appState", "set", { filesPanelHidden: next }).then((result) => {
        if (!result.ok) console.warn("[ui] appState set failed", result.message);
      });
    },

    toggleSidebar() {
      // If anything is hidden, reveal everything; otherwise hide everything.
      // Mirrors VSCode's ⌘B semantics on a layout with two columns.
      let nextSidebarHidden = false;
      let nextFilesPanelHidden = false;
      set((state) => {
        const anythingHidden = state.sidebarHidden || state.filesPanelHidden;
        nextSidebarHidden = !anythingHidden;
        nextFilesPanelHidden = !anythingHidden;
        return {
          sidebarHidden: nextSidebarHidden,
          filesPanelHidden: nextFilesPanelHidden,
        };
      });
      void ipcCallResult("appState", "set", {
        sidebarHidden: nextSidebarHidden,
        filesPanelHidden: nextFilesPanelHidden,
      }).then((result) => {
        if (!result.ok) console.warn("[ui] appState set failed", result.message);
      });
    },
  };
});
