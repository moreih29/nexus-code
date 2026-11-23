import type { InitOptions } from "i18next";

import enCommon from "./locales/en/common.json";
import enDialog from "./locales/en/dialog.json";
import enErrors from "./locales/en/errors.json";
import enFiles from "./locales/en/files.json";
import enMenu from "./locales/en/menu.json";
import enNotes from "./locales/en/notes.json";
import enSettings from "./locales/en/settings.json";

import koCommon from "./locales/ko/common.json";
import koDialog from "./locales/ko/dialog.json";
import koErrors from "./locales/ko/errors.json";
import koFiles from "./locales/ko/files.json";
import koMenu from "./locales/ko/menu.json";
import koNotes from "./locales/ko/notes.json";
import koSettings from "./locales/ko/settings.json";

export const I18N_NAMESPACES = [
  "common",
  "menu",
  "dialog",
  "errors",
  "settings",
  "files",
  "notes",
] as const;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export const I18N_DEFAULT_NS: I18nNamespace = "common";

export const resources = {
  en: {
    common: enCommon,
    menu: enMenu,
    dialog: enDialog,
    errors: enErrors,
    settings: enSettings,
    files: enFiles,
    notes: enNotes,
  },
  ko: {
    common: koCommon,
    menu: koMenu,
    dialog: koDialog,
    errors: koErrors,
    settings: koSettings,
    files: koFiles,
    notes: koNotes,
  },
} as const;

export type I18nResources = typeof resources;
export type SupportedLanguage = keyof I18nResources;
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["en", "ko"] as const;

export interface CreateI18nOptions {
  lng?: SupportedLanguage;
}

export interface CreateI18nResult {
  options: InitOptions;
}

export function createI18n(opts: CreateI18nOptions = {}): CreateI18nResult {
  const lng: SupportedLanguage = opts.lng ?? "en";

  const options: InitOptions = {
    lng,
    fallbackLng: "en",
    ns: I18N_NAMESPACES,
    defaultNS: I18N_DEFAULT_NS,
    resources,
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
    returnEmptyString: false,
  };

  return { options };
}
