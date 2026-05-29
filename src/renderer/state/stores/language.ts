// src/renderer/state/stores/language.ts — Language preference store.
//
// Persistence model (mirrors theme.ts):
//   - appState (main process, via IPC) — authoritative store.
//   - localStorage key "language" — boot cache, read synchronously during
//     i18n init so the first render uses the cached language (no flicker).
//
// Supported values: "en" | "ko". Absent localStorage → navigator.language
// approximation (handled in src/renderer/i18n.ts, not here).

import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import type { SupportedLanguage } from "../../../shared/i18n";
import { SUPPORTED_LANGUAGES } from "../../../shared/i18n";
import { ipcCallResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LANGUAGE_STORAGE_KEY = "language";

const log = createLogger("language-store");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSupportedLanguage(value: string | null): value is SupportedLanguage {
  return value !== null && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function normalize(value: string | null | undefined): SupportedLanguage {
  if (isSupportedLanguage(value ?? null)) return value as SupportedLanguage;
  return "en";
}

/**
 * Resolve the boot language synchronously (no async I/O). This is the SINGLE
 * source of truth shared by both the i18next boot init (src/renderer/i18n.ts)
 * and this store's initial `preference`, so the live UI language and the
 * settings control selection never diverge on first launch.
 *
 * Order:
 *   1. localStorage["language"] — present only after an explicit user choice
 *      (setPreference) or an appState hydrate.
 *   2. navigator.language — OS/browser locale approximation ("ko" prefix → ko).
 *
 * Read-only: never writes localStorage (preserves OS-locale following when the
 * user has made no explicit choice and appState carries no value).
 */
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

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface LanguageState {
  preference: SupportedLanguage;

  /** Hydrate from persisted appState — called once during bootstrap. */
  hydrate(language: SupportedLanguage | null | undefined): void;

  /**
   * Set the user's language preference.
   * Triple-write: i18next.changeLanguage + localStorage (boot cache) +
   * appState (authoritative store).
   */
  setPreference(language: SupportedLanguage): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useLanguageStore = create<LanguageState>((set) => {
  // Initial preference uses the SAME resolution as the i18next boot init
  // (localStorage → navigator.language), so on first launch the settings
  // control reflects the OS-derived language (e.g. Korean system → 한국어
  // selected), matching the actually-rendered UI language.
  const initial = resolveBootLanguage();

  return {
    preference: initial,

    hydrate(language) {
      if (language == null) return; // No authoritative value — keep boot cache.
      const next = normalize(language);
      set({ preference: next });

      // Keep localStorage in sync with appState authoritative value.
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
      }

      // Synchronise the live i18next instance and html[lang] attribute.
      // Import lazily to avoid a circular dependency at module evaluation time
      // (i18n.ts imports this store; this store must not import i18n.ts at
      // the top level).
      import("../../i18n").then(({ rendererI18n }) => {
        void rendererI18n.changeLanguage(next);
        document.documentElement.lang = next;
      }).catch((err: unknown) => {
        log.warn(`hydrate: changeLanguage failed: ${String(err)}`, { correlationId: next });
      });
    },

    setPreference(language) {
      set({ preference: language });

      // Synchronise the live i18next instance and html[lang] attribute.
      import("../../i18n").then(({ rendererI18n }) => {
        void rendererI18n.changeLanguage(language);
        document.documentElement.lang = language;
      }).catch((err: unknown) => {
        log.warn(`setPreference: changeLanguage failed: ${String(err)}`, { correlationId: language });
      });

      // Triple-write: localStorage (boot cache) + appState (authoritative).
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
      }

      void ipcCallResult("appState", "set", { language }).then((result) => {
        if (!result.ok) log.warn("appState set failed");
      });
    },
  };
});
