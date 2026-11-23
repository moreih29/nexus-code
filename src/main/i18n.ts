import i18next, { type i18n, type TFunction } from "i18next";
import { createI18n, SUPPORTED_LANGUAGES, type SupportedLanguage } from "../shared/i18n";
import { createLogger } from "../shared/log/main";

const logger = createLogger("main:i18n");

let _instance: i18n | null = null;

export async function initMainI18n(lng: SupportedLanguage): Promise<void> {
  const { options } = createI18n({ lng });

  const instance = i18next.createInstance();
  await instance.init(options);

  _instance = instance;
  logger.info(`main i18n initialised (lng=${lng})`);
}

export function getMainI18n(): i18n {
  if (_instance === null) {
    throw new Error("[main:i18n] getMainI18n() called before initMainI18n()");
  }
  return _instance;
}

export function getMainT(): TFunction {
  return getMainI18n().t;
}

export function mainLanguage(): SupportedLanguage {
  return SUPPORTED_LANGUAGES.find((lng) => lng === _instance?.language) ?? "en";
}

export function tryGetMainT(): TFunction | null {
  if (_instance === null) return null;
  return _instance.t;
}
