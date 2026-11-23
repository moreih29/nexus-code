import i18next from "i18next";
import { hostPlatform } from "./platform";

export function trashName(platform: string = hostPlatform()): string {
  return platform === "win32"
    ? i18next.t("files:fileTree.delete.recycleBin")
    : i18next.t("files:fileTree.delete.trash");
}
