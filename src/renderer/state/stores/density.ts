// src/renderer/state/stores/density.ts — UI density preference store.
//
// Mirrors the pattern established by state/stores/theme.ts.
//
// Persistence model (mirrors theme.ts decision):
//   - appState (main process, via IPC) — authoritative store.
//   - localStorage key "density" — boot cache, read synchronously by
//     the <head> inline script before first paint (FOUC prevention).
//
// Semantics: 'default' = normal spacing/radius, 'compact' = tighter spacing.
// 'default' is stored as undefined in appState to follow "부재=토큰 fallback" contract.

import { create } from "zustand";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DENSITY_STORAGE_KEY = "density";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DensityPreference = "default" | "compact";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface DensityState {
  preference: DensityPreference;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(value: DensityPreference | undefined): void;

  /**
   * Set the user's density preference.
   * Persists to localStorage (boot cache) + appState (authoritative store).
   * 'default' is stored as undefined in appState to maintain 부재=fallback contract.
   */
  setPreference(value: DensityPreference): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDensityStore = create<DensityState>((set) => {
  // Derive initial preference from localStorage (written by boot script before
  // React loads). Falls back to 'default' if absent/invalid.
  const storedRaw =
    typeof localStorage !== "undefined" ? localStorage.getItem(DENSITY_STORAGE_KEY) : null;
  const initialPreference: DensityPreference = storedRaw === "compact" ? "compact" : "default";

  return {
    preference: initialPreference,

    hydrate(value) {
      const pref: DensityPreference = value === "compact" ? "compact" : "default";
      set({ preference: pref });
      // Keep localStorage in sync with appState authoritative value.
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(DENSITY_STORAGE_KEY, pref);
      }
    },

    setPreference(value) {
      set({ preference: value });

      // Dual-write: localStorage (boot cache) + appState (authoritative).
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(DENSITY_STORAGE_KEY, value);
      }
      // Fire-and-forget: localStorage is the boot cache; appState is the durable store.
      // 'default' maps to undefined to satisfy 부재=토큰 fallback contract.
      void ipcCallResult("appState", "set", {
        density: value === "default" ? undefined : value,
      }).then((result) => {
        if (!result.ok) console.warn("[density] appState set failed", result.message);
      });
    },
  };
});
