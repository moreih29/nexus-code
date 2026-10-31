/*
 * src/main/infra/platform/index.ts
 *
 * Single entry point for all platform-branching functions.
 *
 * The paths come from Electron's app.getPath, which follows each OS's
 * convention: ~/Library/Application Support on macOS, $XDG_CONFIG_HOME (or
 * ~/.config) on Linux, %APPDATA% on Windows.
 */

import os from "node:os";

export { getUserConfigPath, getUserDataPath, getWorkspaceStoragePath } from "./paths";
export { supportsWindowsBackdrop } from "./windows-backdrop";

/**
 * True when the current process is running on macOS. Centralized here so
 * the `process.platform === "darwin"` literal lives in one place — the
 * platform module — and consumers stay readable.
 */
export function isMac(): boolean {
  return process.platform === "darwin";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

/**
 * The user's login shell on macOS and Linux: $SHELL, or, when a GUI launch
 * left it unset, the shell in the user's account record, or the OS default.
 */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.SHELL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { shell } = os.userInfo();
    if (shell) return shell;
  } catch {
    // No account record for this uid, as in some containers.
  }
  return isMac() ? "/bin/zsh" : "/bin/bash";
}
