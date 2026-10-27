/**
 * Platform-native label for revealing a file in the OS file manager, as
 * VSCode words it: Finder on macOS, File Explorer on Windows, and the
 * containing folder elsewhere. Read at call time so it follows the UI
 * language.
 */

import i18next from "i18next";

export function revealInOSLabel(platform: string = hostPlatform()): string {
  if (platform === "darwin") return i18next.t("common:action.reveal_in_finder");
  if (platform === "win32") return i18next.t("common:action.reveal_in_explorer");
  return i18next.t("common:action.open_containing_folder");
}

/** Reads the preload platform bridge when available and falls back to macOS. */
function hostPlatform(): string {
  if (typeof window !== "undefined" && window.host?.platform) return window.host.platform;
  const proc = (globalThis as { process?: { platform?: string } }).process;
  return proc?.platform ?? "darwin";
}
