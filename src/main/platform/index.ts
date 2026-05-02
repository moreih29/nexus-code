/*
 * src/main/platform/index.ts
 *
 * Single entry point for all platform-branching functions.
 * M0: macOS only. All other platforms throw explicitly — no silent fallbacks.
 *
 * M3+ cross-OS checklist:
 *   getDefaultShell
 *     - Windows: pwsh -> powershell.exe -> cmd.exe -> WSL
 *     - Linux:   $SHELL -> /bin/bash fallback
 *   getUserDataPath
 *     - Windows: %APPDATA%/nexus-code
 *     - Linux:   $XDG_DATA_HOME/nexus-code or ~/.local/share/nexus-code
 *   getUserConfigPath
 *     - Windows: %APPDATA%/nexus-code
 *     - Linux:   $XDG_CONFIG_HOME/nexus-code or ~/.config/nexus-code
 *   getWorkspaceStoragePath
 *     - Windows / Linux: follow same data dir conventions as above
 */

export { getDefaultShell } from "./shell";
export { getUserDataPath, getUserConfigPath, getWorkspaceStoragePath } from "./paths";
