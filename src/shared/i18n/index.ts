/**
 * i18n shared infrastructure.
 *
 * Both the main (Node) and renderer (browser) processes import this module.
 * Each process creates its own i18next instance via `createI18n` — the two
 * V8 contexts cannot share an instance.
 *
 * Locale resources are imported as static JSON objects.  Rollup / electron-vite
 * bundles them directly into each target's output at build time, so no
 * filesystem access or HTTP fetch is needed at runtime.  This is safe for both
 * the `node` (main) and `browser` (renderer) Rollup targets.
 *
 * Namespace list (domain-axis, not process-axis):
 *   common, menu, dialog, errors, settings, files
 *
 * Usage — main process:
 *   import { createI18n } from "../shared/i18n";
 *   import i18next from "i18next";
 *   const { options } = createI18n({ lng: "ko" });
 *   await i18next.init(options);
 *
 * Usage — renderer process (react-i18next):
 *   import { createI18n } from "../../shared/i18n";
 *   import i18next from "i18next";
 *   import { initReactI18next } from "react-i18next";
 *   const { options } = createI18n({ lng: "ko" });
 *   await i18next.use(initReactI18next).init(options);
 */

import type { InitOptions } from "i18next";

// ---------------------------------------------------------------------------
// Locale JSON imports — bundled as static objects by Rollup.
// ---------------------------------------------------------------------------
import enCommon from "./locales/en/common.json";
import enDialog from "./locales/en/dialog.json";
import enErrors from "./locales/en/errors.json";
import enFiles from "./locales/en/files.json";
import enMenu from "./locales/en/menu.json";
import enSettings from "./locales/en/settings.json";

import koCommon from "./locales/ko/common.json";
import koDialog from "./locales/ko/dialog.json";
import koErrors from "./locales/ko/errors.json";
import koFiles from "./locales/ko/files.json";
import koMenu from "./locales/ko/menu.json";
import koSettings from "./locales/ko/settings.json";

// ---------------------------------------------------------------------------
// Namespace list — single source of truth consumed by the type augmentation
// and by `createI18n`.
// ---------------------------------------------------------------------------
export const I18N_NAMESPACES = ["common", "menu", "dialog", "errors", "settings", "files"] as const;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export const I18N_DEFAULT_NS: I18nNamespace = "common";

// ---------------------------------------------------------------------------
// Bundled resources object.
// ---------------------------------------------------------------------------
export const resources = {
  en: {
    common: enCommon,
    menu: enMenu,
    dialog: enDialog,
    errors: enErrors,
    settings: enSettings,
    files: enFiles,
  },
  ko: {
    common: koCommon,
    menu: koMenu,
    dialog: koDialog,
    errors: koErrors,
    settings: koSettings,
    files: koFiles,
  },
} as const;

export type I18nResources = typeof resources;
export type SupportedLanguage = keyof I18nResources;
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["en", "ko"] as const;

// ---------------------------------------------------------------------------
// Factory options type.
// ---------------------------------------------------------------------------
export interface CreateI18nOptions {
  /** Active language.  Defaults to "en". */
  lng?: SupportedLanguage;
}

export interface CreateI18nResult {
  /**
   * Ready-to-pass InitOptions for `i18next.init(options)` (core) or
   * `i18next.use(initReactI18next).init(options)` (renderer).
   *
   * All locale resources are pre-bundled; no backend plugin is needed.
   */
  options: InitOptions;
}

// ---------------------------------------------------------------------------
// Factory — produces InitOptions; does NOT call i18next.init() itself so that
// the caller can attach plugins (e.g. initReactI18next) before initialising.
// ---------------------------------------------------------------------------
export function createI18n(opts: CreateI18nOptions = {}): CreateI18nResult {
  const lng: SupportedLanguage = opts.lng ?? "en";

  const options: InitOptions = {
    lng,
    fallbackLng: "en",
    ns: I18N_NAMESPACES,
    defaultNS: I18N_DEFAULT_NS,
    resources,
    interpolation: {
      // React already escapes values — disable double-escaping.
      escapeValue: false,
    },
    returnNull: false,
    // Surface missing keys as the key string rather than an empty value so
    // missing translations are immediately visible during development.
    returnEmptyString: false,
  };

  return { options };
}
