import { resources, type SupportedLanguage } from "../../../shared/i18n";

export type UserDataApp = Pick<import("electron").App, "getPath">;

export function hasUserData(app: UserDataApp): boolean {
  try {
    app.getPath("userData");
    return true;
  } catch {
    return false;
  }
}

export function userDataUnavailableText(locale: string): { title: string; message: string } {
  const language: SupportedLanguage = locale.toLowerCase().startsWith("ko") ? "ko" : "en";
  return resources[language].dialog.userDataUnavailable;
}
