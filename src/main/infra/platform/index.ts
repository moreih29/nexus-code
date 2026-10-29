/*
 * src/main/infra/platform/index.ts
 *
 * Single entry point for all platform-branching functions.
 *
 * The paths come from Electron's app.getPath, which follows each OS's
 * convention: ~/Library/Application Support on macOS, $XDG_CONFIG_HOME (or
 * ~/.config) on Linux, %APPDATA% on Windows.
 */

export { getUserConfigPath, getUserDataPath, getWorkspaceStoragePath } from "./paths";

/**
 * True when the current process is running on macOS. Centralized here so
 * the `process.platform === "darwin"` literal lives in one place — the
 * platform module — and consumers stay readable.
 */
export function isMac(): boolean {
  return process.platform === "darwin";
}
