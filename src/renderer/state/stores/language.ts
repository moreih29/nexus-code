import { create } from "zustand";
import type { SupportedLanguage } from "../../../shared/i18n";
import { SUPPORTED_LANGUAGES } from "../../../shared/i18n";
import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";

export const LANGUAGE_STORAGE_KEY = "language";

const log = createLogger("language-store");

function isSupportedLanguage(value: string | null): value is SupportedLanguage {
  return value !== null && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function normalize(value: string | null | undefined): SupportedLanguage {
  if (isSupportedLanguage(value ?? null)) return value as SupportedLanguage;
  return "en";
}

export function resolveBootLanguage(): SupportedLanguage {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isSupportedLanguage(stored)) return stored;
  }
  if (typeof navigator !== "undefined" && (navigator.language ?? "").startsWith("ko")) {
    return "ko";
  }
  return "en";
}

interface LanguageState {
  preference: SupportedLanguage;

  hydrate(language: SupportedLanguage | null | undefined): void;

  setPreference(language: SupportedLanguage): void;
}

export const useLanguageStore = create<LanguageState>((set) => {
  const initial = resolveBootLanguage();

  return {
    preference: initial,

    hydrate(language) {
      if (language == null) return;
      const next = normalize(language);
      set({ preference: next });

      if (typeof localStorage !== "undefined") {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
      }

      import("../../i18n")
        .then(({ rendererI18n }) => {
          void rendererI18n.changeLanguage(next);
          document.documentElement.lang = next;
        })
        .catch((err: unknown) => {
          log.warn(`hydrate: changeLanguage failed: ${String(err)}`, { correlationId: next });
        });
    },

    setPreference(language) {
      set({ preference: language });

      import("../../i18n")
        .then(({ rendererI18n }) => {
          void rendererI18n.changeLanguage(language);
          document.documentElement.lang = language;
        })
        .catch((err: unknown) => {
          log.warn(`setPreference: changeLanguage failed: ${String(err)}`, {
            correlationId: language,
          });
        });

      if (typeof localStorage !== "undefined") {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
      }

      void ipcCallResult("appState", "set", { language }).then((result) => {
        if (!result.ok) log.warn("appState set failed");
      });
    },
  };
});
