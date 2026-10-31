/**
 * WSL workspace service — wraps the `wsl.*` IPC channels and the WSL form of
 * `workspace.createAndConnect`.
 *
 * A WSL browse session is browsed and closed through the SSH browse-session
 * functions (`browseSshSession`, `closeSshBrowseSession`), whose main
 * handlers serve both.
 */

import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { IpcResult } from "../../ipc/client";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";

/** The installed WSL distributions; empty off Windows or without WSL. */
export async function listWslDistros(): Promise<string[]> {
  return unwrapIpcResult(await ipcCallResult("wsl", "listDistros", undefined));
}

/**
 * Start the agent in `distro` for the folder picker. `progressId` keys its
 * install progress on `ssh.browseProgress`. Throws with what wsl.exe said
 * when the distribution cannot start.
 */
export async function openWslBrowseSession(
  distro: string,
  progressId?: string,
): Promise<{ sessionId: string; initialPath: string }> {
  return unwrapIpcResult(await ipcCallResult("wsl", "openBrowseSession", { distro, progressId }));
}

/** Create a workspace on `remotePath` inside `distro` and connect it. */
export async function createWslWorkspace(args: {
  readonly distro: string;
  readonly remotePath: string;
}): Promise<IpcResult<WorkspaceMeta>> {
  return ipcCallResult("workspace", "createAndConnect", {
    location: { kind: "wsl", distro: args.distro, remotePath: args.remotePath },
  });
}
