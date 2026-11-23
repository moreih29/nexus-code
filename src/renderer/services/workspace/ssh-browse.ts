import type { DirEntry } from "../../../shared/fs/types";
import { ipcOk } from "../../../shared/ipc/result";
import type { SshBrowseProgressEvent } from "../../../shared/types/workspace";
import type { IpcResult } from "../../ipc/client";
import { ipcCallResult, ipcListen } from "../../ipc/client";

export interface OpenBrowseSessionArgs {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly authMode: "interactive" | "key-only";
  readonly progressId?: string;
}

export interface BrowseSessionInfo {
  readonly sessionId: string;
  readonly initialPath: string;
  readonly user: string;
}

export async function openSshBrowseSession(
  args: OpenBrowseSessionArgs,
): Promise<IpcResult<BrowseSessionInfo>> {
  return ipcCallResult("ssh", "openBrowseSession", {
    host: args.host,
    user: args.user,
    port: args.port,
    identityFile: args.identityFile,
    authMode: args.authMode,
    progressId: args.progressId,
  });
}

export function subscribeSshBrowseProgress(
  callback: (event: SshBrowseProgressEvent) => void,
): () => void {
  return ipcListen("ssh", "browseProgress", callback);
}

export interface BrowseSessionResult {
  readonly entries: readonly DirEntry[];
  readonly truncated: boolean;
}

export async function browseSshSession(
  sessionId: string,
  path: string,
): Promise<IpcResult<BrowseSessionResult>> {
  const result = await ipcCallResult("ssh", "browseSession", { sessionId, path });
  if (!result.ok) return result;
  const dirs = result.value.entries
    .filter((e) => e.type === "dir" || e.type === "symlink")
    .sort((a, b) => a.name.localeCompare(b.name));
  return ipcOk({ entries: dirs, truncated: result.value.truncated });
}

export async function prefetchSshDirectory(
  sessionId: string,
  path: string,
): Promise<BrowseSessionResult | null> {
  try {
    const result = await browseSshSession(sessionId, path);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

export async function closeSshBrowseSession(sessionId: string): Promise<void> {
  await ipcCallResult("ssh", "closeBrowseSession", { sessionId }).catch(() => {});
}
