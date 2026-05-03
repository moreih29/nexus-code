import { create } from "zustand";
import { ipcCall } from "../ipc/client";

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
  filesPanelCollapsed?: boolean;
}

interface UIState {
  sidebarWidth: number;
  filesPanelWidth: number;
  filesPanelCollapsed: boolean;
  hydrate(opts: HydrateOpts): void;
  setSidebarWidth(width: number, persist?: boolean): void;
  setFilesPanelWidth(width: number, persist?: boolean): void;
  toggleFilesPanel(): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useUIStore = create<UIState>((set, get) => ({
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  filesPanelWidth: FILES_PANEL_WIDTH_DEFAULT,
  filesPanelCollapsed: false,

  hydrate({ sidebarWidth, filesPanelWidth, filesPanelCollapsed }) {
    set({
      sidebarWidth: sidebarWidth !== undefined ? clampSidebar(sidebarWidth) : SIDEBAR_WIDTH_DEFAULT,
      filesPanelWidth:
        filesPanelWidth !== undefined
          ? clampFilesPanel(filesPanelWidth)
          : FILES_PANEL_WIDTH_DEFAULT,
      filesPanelCollapsed: filesPanelCollapsed ?? false,
    });
  },

  setSidebarWidth(width, persist) {
    const next = clampSidebar(width);
    set({ sidebarWidth: next });
    if (persist) {
      ipcCall("appState", "set", { sidebarWidth: next }).catch(() => {});
    }
  },

  setFilesPanelWidth(width, persist) {
    const next = clampFilesPanel(width);
    set({ filesPanelWidth: next });
    if (persist) {
      ipcCall("appState", "set", { filesPanelWidth: next }).catch(() => {});
    }
  },

  toggleFilesPanel() {
    const next = !get().filesPanelCollapsed;
    set({ filesPanelCollapsed: next });
    ipcCall("appState", "set", { filesPanelCollapsed: next }).catch(() => {});
  },
}));
