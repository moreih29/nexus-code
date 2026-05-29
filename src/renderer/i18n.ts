/**
 * Renderer-process i18next initialisation.
 *
 * This module creates and exports the single renderer-side i18next instance.
 * It must be initialised (via `initRendererI18n`) before React mounts so that
 * the first render uses the correct language and there is no translation flicker.
 *
 * Boot language resolution order (synchronous, no async I/O):
 *   1. localStorage["language"]  — present only when the user has previously
 *      made an explicit choice (written by setPreference or hydrate).
 *   2. navigator.language        — OS/browser locale approximation.
 *      "ko" prefix → "ko", anything else → "en".
 *
 * Intentionally read-only at boot: resolveBootLanguage() never writes to
 * localStorage. Writing is the exclusive responsibility of setPreference
 * (user explicit choice) and hydrate (appState authoritative value present).
 * This preserves OS locale following: if the user has never chosen a language
 * and appState carries no value, every boot re-reads navigator.language so an
 * OS locale change takes effect on the next launch without a manual override.
 *
 * The authoritative value (appState.language) is applied later in
 * bootstrapAppState via useLanguageStore.hydrate(), which calls
 * rendererI18n.changeLanguage(). Any mismatch is corrected before the first
 * user interaction; the only visible window is the initial render frame.
 *
 * react-i18next reads from the global i18next singleton (i18next.global) when
 * no I18nextProvider is used. We initialise via the exported `rendererI18n`
 * instance (which IS the global singleton imported from "i18next"), so
 * useTranslation() works out-of-the-box without a wrapper Provider.
 */

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { createI18n } from "../shared/i18n";
import { resolveBootLanguage } from "./state/stores/language";

// resolveBootLanguage lives in the language store module (the single source of
// truth shared with the store's initial `preference`) so the live UI language
// and the settings control selection never diverge on first launch.

// ---------------------------------------------------------------------------
// i18next instance — the default export from "i18next" IS the global
// singleton. react-i18next's useTranslation() hooks into it automatically.
// ---------------------------------------------------------------------------

export const rendererI18n = i18next;

// ---------------------------------------------------------------------------
// Initialise — must complete before React.render()
// ---------------------------------------------------------------------------

/**
 * Initialise the renderer i18next instance synchronously (resources are
 * pre-bundled; no network fetch required).
 *
 * The returned Promise resolves when i18next's internal async init path
 * completes. Because all resources are bundled, this resolves essentially
 * instantly. Callers should `await` it before calling `createRoot().render()`.
 */
export async function initRendererI18n(): Promise<void> {
  const lng = resolveBootLanguage();

  // Set html[lang] immediately — before the first render frame.
  // This is NOT a persistence write; the attribute is re-derived on every boot.
  if (typeof document !== "undefined") {
    document.documentElement.lang = lng;
  }

  const { options } = createI18n({ lng });

  // initReactI18next hooks into i18next so that useTranslation() works
  // without an explicit I18nextProvider in the React tree.
  await rendererI18n.use(initReactI18next).init(options);
}
