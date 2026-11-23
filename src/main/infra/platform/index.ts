import os from "node:os";

export { getUserConfigPath, getUserDataPath, getWorkspaceStoragePath } from "./paths";
export { supportsWindowsBackdrop } from "./windows-backdrop";

export function isMac(): boolean {
  return process.platform === "darwin";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.SHELL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { shell } = os.userInfo();
    if (shell) return shell;
  } catch {}
  return isMac() ? "/bin/zsh" : "/bin/bash";
}
