// src/renderer/state/stores/theme.ts — Theme preference + resolved theme store.
//
// Separated from ui.ts — different aggregation axis (display system vs layout state).
// design.md plan.json Issue 3 decision (4): "state/stores/theme.ts 신설 — ui.ts에 안 넣음"
//
// Persistence model (plan.json decision (5)):
//   - appState (main process, via IPC) — authoritative store, also used by
//     main to set titleBarOverlay color on window creation.
//   - localStorage key "themePreference" — boot cache, read synchronously by
//     the <head> inline script before first paint (FOUC prevention).
//
// OS Auto pair: warm-dark ⇄ warm-light (same hue family, no hue jump).
// cool-dark: explicit selection only; OS tracking disabled when cool-dark is active.

import { create } from "zustand";
import type { ThemePreference } from "../../../shared/types/app-state";
import type { ThemeId } from "../../../shared/design-tokens";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = "themePreference";

// OS Auto pair mapping (design.md §8: warm-dark ⇄ warm-light).
// cool-dark is always P1 (explicit, OS-tracking disabled).
const OS_DARK_THEME: ThemeId = "warm-dark";
const OS_LIGHT_THEME: ThemeId = "warm-light";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveFromOS(isDark: boolean): ThemeId {
  return isDark ? OS_DARK_THEME : OS_LIGHT_THEME;
}

function resolvePreference(preference: ThemePreference, isDark: boolean): ThemeId {
  if (preference === "system") {
    return resolveFromOS(isDark);
  }
  return preference;
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface ThemeState {
  preference: ThemePreference;
  resolved: ThemeId;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(preference: ThemePreference | undefined): void;

  /**
   * Set the user's theme preference.
   * Persists to localStorage (boot cache) + appState (authoritative store).
   */
  setPreference(preference: ThemePreference): void;

  /**
   * Update the resolved theme when the OS color scheme changes.
   * Only applied when preference === "system".
   * Called by useThemeEffect's matchMedia listener.
   */
  resolveFromMediaQuery(isDark: boolean): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useThemeStore = create<ThemeState>((set, get) => {
  // Derive initial resolved theme from localStorage (written by boot script
  // before React loads). Falls back to DEFAULT_THEME if not set.
  const storedRaw = typeof localStorage !== "undefined"
    ? (localStorage.getItem(THEME_STORAGE_KEY) as ThemePreference | null)
    : null;
  const initialPreference: ThemePreference = storedRaw ?? "system";
  const initialOsDark =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true;
  const initialResolved = resolvePreference(initialPreference, initialOsDark);

  return {
    preference: initialPreference,
    resolved: initialResolved,

    hydrate(preference) {
      const pref = preference ?? "system";
      const isDark =
        typeof window !== "undefined"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
          : true;
      set({
        preference: pref,
        resolved: resolvePreference(pref, isDark),
      });
      // Keep localStorage in sync with appState authoritative value.
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(THEME_STORAGE_KEY, pref);
      }
    },

    setPreference(preference) {
      const isDark =
        typeof window !== "undefined"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
          : true;
      const resolved = resolvePreference(preference, isDark);
      set({ preference, resolved });

      // Dual-write: localStorage (boot cache) + appState (authoritative).
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(THEME_STORAGE_KEY, preference);
      }
      // Fire-and-forget: localStorage is the boot cache; appState is the durable store.
      void ipcCallResult("appState", "set", {
        themePreference: preference === "system" ? undefined : preference,
      }).then((result) => {
        if (!result.ok) console.warn("[theme] appState set failed", result.message);
      });
    },

    resolveFromMediaQuery(isDark) {
      const { preference } = get();
      if (preference !== "system") return;
      set({ resolved: resolveFromOS(isDark) });
    },
  };
});
