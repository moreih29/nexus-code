import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";

export const ICON_THEME_STORAGE_KEY = "iconTheme";

export const ICON_THEMES = ["minimal", "material"] as const;
export type IconTheme = (typeof ICON_THEMES)[number];

const DEFAULT_ICON_THEME: IconTheme = "minimal";

const log = createLogger("icon-theme-store");

function isIconTheme(value: string | null): value is IconTheme {
  return value !== null && (ICON_THEMES as readonly string[]).includes(value);
}

function normalize(value: string | null | undefined): IconTheme {
  if (isIconTheme(value ?? null)) return value as IconTheme;
  return DEFAULT_ICON_THEME;
}

interface IconThemeState {
  preference: IconTheme;

  resolved: IconTheme;

  hydrate(iconTheme: IconTheme | null | undefined): void;

  setPreference(iconTheme: IconTheme): void;
}

export const useIconThemeStore = create<IconThemeState>((set) => {
  const storedRaw =
    typeof localStorage !== "undefined" ? localStorage.getItem(ICON_THEME_STORAGE_KEY) : null;
  const initial = normalize(storedRaw);

  return {
    preference: initial,
    resolved: initial,

    hydrate(iconTheme) {
      if (iconTheme == null) return;
      const next = normalize(iconTheme);
      set({ preference: next, resolved: next });

      if (typeof localStorage !== "undefined") {
        localStorage.setItem(ICON_THEME_STORAGE_KEY, next);
      }
    },

    setPreference(iconTheme) {
      set({ preference: iconTheme, resolved: iconTheme });

      if (typeof localStorage !== "undefined") {
        localStorage.setItem(ICON_THEME_STORAGE_KEY, iconTheme);
      }

      void ipcCallResult("appState", "set", { iconTheme }).then((result) => {
        if (!result.ok) log.warn("appState set failed");
      });
    },
  };
});
