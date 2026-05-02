import { create } from "zustand";
import { ipcCall } from "../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 240;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, value));
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface UIState {
  sidebarWidth: number;
  hydrate(width?: number): void;
  setSidebarWidth(width: number, persist?: boolean): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useUIStore = create<UIState>((set) => ({
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,

  hydrate(width) {
    set({ sidebarWidth: width !== undefined ? clamp(width) : SIDEBAR_WIDTH_DEFAULT });
  },

  setSidebarWidth(width, persist) {
    const next = clamp(width);
    set({ sidebarWidth: next });
    if (persist) {
      ipcCall("appState", "set", { sidebarWidth: next }).catch(() => {});
    }
  },
}));
