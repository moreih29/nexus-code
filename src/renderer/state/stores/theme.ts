// src/renderer/state/stores/theme.ts — Theme preference + resolved theme store.
//
// Separated from ui.ts — different aggregation axis (display system vs layout state).
//
// Persistence model:
//   - appState (main process, via IPC) — authoritative store, also used by
//     main to set titleBarOverlay color on window creation.
//   - localStorage key "themePreference" — boot cache, read synchronously by
//     the <head> inline script before first paint (FOUC prevention).
//
// The previous "system" (OS Auto) preference was removed when external themes
// replaced the first-party warm/cool pair: with only a single light variant
// shipping (GitHub Light), there is no deterministic dark partner to swap to.
// Theme selection is now always explicit; preference === resolved.

import { create } from "zustand";
import { DEFAULT_THEME, THEMES, type ThemeId } from "../../../shared/design-tokens";
import type { ThemePreference } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = "themePreference";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isThemeId(value: string | null): value is ThemeId {
  // `in` is safe — THEMES is a plain object literal built from THEME_SOURCES,
  // not a class instance with potentially exploitable prototype methods.
  return value !== null && value in THEMES;
}

function normalize(value: ThemePreference | null | undefined): ThemeId {
  if (value && isThemeId(value)) return value;
  return DEFAULT_THEME;
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface ThemeState {
  preference: ThemeId;
  resolved: ThemeId;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(preference: ThemePreference | undefined): void;

  /**
   * Set the user's theme preference.
   * Persists to localStorage (boot cache) + appState (authoritative store).
   */
  setPreference(preference: ThemeId): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useThemeStore = create<ThemeState>((set) => {
  // Derive initial resolved theme from localStorage (written by boot script
  // before React loads). Falls back to DEFAULT_THEME if not set or unknown.
  const storedRaw = typeof localStorage !== "undefined"
    ? (localStorage.getItem(THEME_STORAGE_KEY) as ThemePreference | null)
    : null;
  const initial = normalize(storedRaw);

  return {
    preference: initial,
    resolved: initial,

    hydrate(preference) {
      const next = normalize(preference);
      set({ preference: next, resolved: next });
      // Keep localStorage in sync with appState authoritative value.
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    },

    setPreference(preference) {
      set({ preference, resolved: preference });

      // Dual-write: localStorage (boot cache) + appState (authoritative).
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(THEME_STORAGE_KEY, preference);
      }
      // Fire-and-forget: localStorage is the boot cache; appState is the durable store.
      void ipcCallResult("appState", "set", {
        themePreference: preference,
      }).then((result) => {
        if (!result.ok) console.warn("[theme] appState set failed", result.message);
      });
    },
  };
});
