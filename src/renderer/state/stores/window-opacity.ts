// src/renderer/state/stores/window-opacity.ts — Window opacity preference store.
//
// Mirrors the pattern established by state/stores/theme.ts.
//
// Persistence model (mirrors theme.ts decision):
//   - appState (main process, via IPC) — authoritative store.
//   - localStorage key "windowOpacity" — boot cache, read synchronously by
//     the <head> inline script before first paint (FOUC prevention).
//
// Semantics: 0 = fully transparent, 1 = fully opaque (default).
// Mirrors Ghostty's background-opacity semantics.
// Changing this requires an app restart — `transparent` is constructor-only in Electron.

import { create } from "zustand";
import { ipcCall } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WINDOW_OPACITY_STORAGE_KEY = "windowOpacity";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface WindowOpacityState {
  opacity: number;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(opacity: number | undefined): void;

  /**
   * Set the window opacity preference.
   * Persists to localStorage (boot cache) + appState (authoritative store).
   */
  setOpacity(opacity: number): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWindowOpacityStore = create<WindowOpacityState>((set) => {
  // Derive initial opacity from localStorage (written by boot script before
  // React loads). Falls back to 1 (fully opaque) if absent/invalid.
  const storedRaw =
    typeof localStorage !== "undefined" ? localStorage.getItem(WINDOW_OPACITY_STORAGE_KEY) : null;
  const parsed = storedRaw !== null ? parseFloat(storedRaw) : Number.NaN;
  const initialOpacity = !Number.isNaN(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;

  return {
    opacity: initialOpacity,

    hydrate(opacity) {
      const value = opacity ?? 1;
      set({ opacity: value });
      // Keep localStorage in sync with appState authoritative value.
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(WINDOW_OPACITY_STORAGE_KEY, String(value));
      }
    },

    setOpacity(opacity) {
      set({ opacity });

      // Dual-write: localStorage (boot cache) + appState (authoritative).
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(WINDOW_OPACITY_STORAGE_KEY, String(opacity));
      }
      ipcCall("appState", "set", {
        windowOpacity: opacity === 1 ? undefined : opacity,
      }).catch(() => {});
    },
  };
});
