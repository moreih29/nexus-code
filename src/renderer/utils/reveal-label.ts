import i18next from "i18next";
import { hostPlatform } from "./platform";

export function revealInOSLabel(platform: string = hostPlatform()): string {
  if (platform === "darwin") return i18next.t("common:action.reveal_in_finder");
  if (platform === "win32") return i18next.t("common:action.reveal_in_explorer");
  return i18next.t("common:action.open_containing_folder");
}
