import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { createI18n } from "../shared/i18n";
import { resolveBootLanguage } from "./state/stores/language";

export const rendererI18n = i18next;

export async function initRendererI18n(): Promise<void> {
  const lng = resolveBootLanguage();

  if (typeof document !== "undefined") {
    document.documentElement.lang = lng;
  }

  const { options } = createI18n({ lng });

  await rendererI18n.use(initReactI18next).init(options);
}
