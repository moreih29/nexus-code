/**
 * Main-process i18n instance.
 *
 * Uses i18next.createInstance() so the main-process instance is fully isolated
 * from the renderer's default i18next singleton — the two V8 contexts cannot
 * share state and renderer plugins (initReactI18next) must never load here.
 *
 * Usage from this module:
 *   import { initMainI18n, getMainT } from "./i18n";
 *   await initMainI18n("ko");
 *   const t = getMainT(); // i18next TFunction, ready after init
 *
 * T6 wiring note:
 *   installAppMenu (src/main/features/menu/index.ts) currently accepts an
 *   `InstallAppMenuOptions` bag.  When T6 adds translation support it should:
 *     1. Extend InstallAppMenuOptions with `t?: TFunction` (or accept a
 *        `getT: () => TFunction` thunk for lazy re-builds).
 *     2. Pass `getMainT()` at the call site in src/main/index.ts.
 *     3. buildMenuTemplate remains a pure function; T6 threads `t` through
 *        it by adding an optional `t` parameter to BuildMenuOptions.
 *   Language change events (appState.set { language }) should call
 *   `mainI18n.changeLanguage(lang)` and then reinstall the menu.  That
 *   coupling is T6's responsibility — this module only provides init + handle.
 */

import i18next, { type i18n, type TFunction } from "i18next";
import { createLogger } from "../shared/log/main";
import { createI18n } from "../shared/i18n";
import type { SupportedLanguage } from "../shared/i18n";

const logger = createLogger("main:i18n");

// ---------------------------------------------------------------------------
// Module-level singleton — set once by initMainI18n(), read by getMainT().
// ---------------------------------------------------------------------------

let _instance: i18n | null = null;

/**
 * Initialise the main-process i18next instance with the resolved language.
 *
 * Must be called inside app.whenReady() after the language has been determined
 * from appState or OS locale.  Awaiting ensures the instance is ready before
 * any consumer calls getMainT().
 */
export async function initMainI18n(lng: SupportedLanguage): Promise<void> {
  const { options } = createI18n({ lng });

  // createInstance() produces a fully isolated i18next instance; it does not
  // share any state with i18next's default export which the renderer may use.
  const instance = i18next.createInstance();
  await instance.init(options);

  _instance = instance;
  logger.info(`main i18n initialised (lng=${lng})`);
}

/**
 * Returns the main-process i18next instance handle.
 *
 * Callers that need the raw instance (e.g. T6's changeLanguage call) receive
 * the full i18n object.  Throws if called before initMainI18n() completes.
 */
export function getMainI18n(): i18n {
  if (_instance === null) {
    throw new Error("[main:i18n] getMainI18n() called before initMainI18n()");
  }
  return _instance;
}

/**
 * Returns the bound TFunction for the main-process instance.
 *
 * Convenience wrapper so menu/dialog builders can import a single symbol
 * rather than destructuring from getMainI18n().
 *
 * Throws if called before initMainI18n() completes.
 */
export function getMainT(): TFunction {
  return getMainI18n().t;
}

/**
 * Returns the bound TFunction if i18n is initialized, otherwise null.
 *
 * Use this in code paths that may run before initMainI18n() completes —
 * callers must provide an English fallback when null is returned.
 */
export function tryGetMainT(): TFunction | null {
  if (_instance === null) return null;
  return _instance.t;
}
