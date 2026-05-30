// src/renderer/state/stores/icon-theme.ts — Icon theme preference store.
//
// Persistence model (mirrors theme.ts / language.ts):
//   - appState (main process, via IPC) — authoritative store.
//   - localStorage key "iconTheme" — boot cache, read synchronously during
//     store creation so the first render uses the cached value (no flicker).
//
// Supported values: "minimal" | "material". Absent = "minimal" (default).
// The resolved value is always identical to the preference (there are only
// two explicit choices; no OS-derived inference is needed).

import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key used as a boot cache for icon theme (avoids a round-trip
 * to main on first paint). Written by setPreference and hydrate. */
export const ICON_THEME_STORAGE_KEY = "iconTheme";

/** Closed set of icon theme identifiers. */
export const ICON_THEMES = ["minimal", "material"] as const;
export type IconTheme = (typeof ICON_THEMES)[number];

/** Default icon theme applied when no preference has been stored. */
const DEFAULT_ICON_THEME: IconTheme = "minimal";

const log = createLogger("icon-theme-store");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard — confirms the raw string is a valid IconTheme. */
function isIconTheme(value: string | null): value is IconTheme {
  return value !== null && (ICON_THEMES as readonly string[]).includes(value);
}

/** Coerce any persisted or hydrated value to a valid IconTheme, falling back
 * to DEFAULT_ICON_THEME when the value is absent or unrecognised. */
function normalize(value: string | null | undefined): IconTheme {
  if (isIconTheme(value ?? null)) return value as IconTheme;
  return DEFAULT_ICON_THEME;
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface IconThemeState {
  /** The user's stored preference — equals resolved (no OS derivation). */
  preference: IconTheme;

  /**
   * The active icon theme to render. Always equals preference; exposed as a
   * distinct field so consumers can subscribe via
   * `useIconThemeStore(s => s.resolved)` without coupling to internal naming.
   */
  resolved: IconTheme;

  /**
   * Hydrate from the persisted appState snapshot — called once during
   * bootstrap (bootstrapAppState).  Does NOT call appState.set or trigger
   * any broadcast, preventing a hydrate → set → broadcast feedback loop.
   */
  hydrate(iconTheme: IconTheme | null | undefined): void;

  /**
   * Set the user's icon theme preference.
   * Triple-write: zustand state + localStorage (boot cache) +
   * appState (authoritative store via IPC).
   */
  setPreference(iconTheme: IconTheme): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useIconThemeStore = create<IconThemeState>((set) => {
  // Derive the initial value from localStorage synchronously so the first
  // render reflects a previously stored preference without waiting for IPC.
  const storedRaw =
    typeof localStorage !== "undefined" ? localStorage.getItem(ICON_THEME_STORAGE_KEY) : null;
  const initial = normalize(storedRaw);

  return {
    preference: initial,
    resolved: initial,

    hydrate(iconTheme) {
      if (iconTheme == null) return; // No authoritative value — keep boot cache as-is.
      const next = normalize(iconTheme);
      // Update zustand state only — no IPC, no broadcast (avoids feedback loop).
      set({ preference: next, resolved: next });

      // Keep localStorage in sync with the appState authoritative value so the
      // next cold boot uses the correct theme immediately.
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(ICON_THEME_STORAGE_KEY, next);
      }
    },

    setPreference(iconTheme) {
      set({ preference: iconTheme, resolved: iconTheme });

      // Triple-write: localStorage (boot cache) + appState (authoritative).
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(ICON_THEME_STORAGE_KEY, iconTheme);
      }

      void ipcCallResult("appState", "set", { iconTheme }).then((result) => {
        if (!result.ok) log.warn("appState set failed");
      });
    },
  };
});
