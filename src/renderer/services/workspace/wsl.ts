import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { IpcResult } from "../../ipc/client";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";

export async function listWslDistros(): Promise<string[]> {
  return unwrapIpcResult(await ipcCallResult("wsl", "listDistros", undefined));
}

export async function openWslBrowseSession(
  distro: string,
  progressId?: string,
  signal?: AbortSignal,
): Promise<IpcResult<{ sessionId: string; initialPath: string }>> {
  return ipcCallResult("wsl", "openBrowseSession", { distro, progressId }, { signal });
}

export async function createWslWorkspace(args: {
  readonly distro: string;
  readonly remotePath: string;
}): Promise<IpcResult<WorkspaceMeta>> {
  return ipcCallResult("workspace", "createAndConnect", {
    location: { kind: "wsl", distro: args.distro, remotePath: args.remotePath },
  });
}
