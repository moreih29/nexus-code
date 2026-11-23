import { create } from "zustand";
import { DEFAULT_THEME, THEMES, type ThemeId } from "../../../shared/design-tokens";
import { createLogger } from "../../../shared/log/renderer";
import type { ThemePreference } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";

const log = createLogger("theme");

const THEME_STORAGE_KEY = "themePreference";

function isThemeId(value: string | null): value is ThemeId {
  return value !== null && value in THEMES;
}

function normalize(value: ThemePreference | null | undefined): ThemeId {
  if (value && isThemeId(value)) return value;
  return DEFAULT_THEME;
}

interface ThemeState {
  preference: ThemeId;
  resolved: ThemeId;

  hydrate(preference: ThemePreference | undefined): void;

  setPreference(preference: ThemeId): void;
}

export const useThemeStore = create<ThemeState>((set) => {
  const storedRaw =
    typeof localStorage !== "undefined"
      ? (localStorage.getItem(THEME_STORAGE_KEY) as ThemePreference | null)
      : null;
  const initial = normalize(storedRaw);

  return {
    preference: initial,
    resolved: initial,

    hydrate(preference) {
      const next = normalize(preference);
      set({ preference: next, resolved: next });
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    },

    setPreference(preference) {
      set({ preference, resolved: preference });

      if (typeof localStorage !== "undefined") {
        localStorage.setItem(THEME_STORAGE_KEY, preference);
      }
      void ipcCallResult("appState", "set", {
        themePreference: preference,
      }).then((result) => {
        if (!result.ok) log.warn(`appState set failed: ${result.message}`);
      });
    },
  };
});
