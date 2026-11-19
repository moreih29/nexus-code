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
 * install progress on `ssh.browseProgress`. Returns failures in the IPC envelope.
 */
export async function openWslBrowseSession(
  distro: string,
  progressId?: string,
  signal?: AbortSignal,
): Promise<IpcResult<{ sessionId: string; initialPath: string }>> {
  return ipcCallResult("wsl", "openBrowseSession", { distro, progressId }, { signal });
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
