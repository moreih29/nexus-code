/**
 * Workspace creation service — wraps `workspace.create`, `workspace.createAndConnect`,
 * and `dialog.showOpenDirectory` IPC channels.
 *
 * Exposes intent-level functions so components never import ipc/client directly.
 */

import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCall, ipcCallResult } from "../../ipc/client";
import type { IpcResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Local workspace
// ---------------------------------------------------------------------------

/**
 * Create a local workspace from an absolute path.
 * Throws on IPC error (the caller handles it).
 */
export async function createLocalWorkspace(rootPath: string): Promise<WorkspaceMeta> {
  return ipcCall("workspace", "create", {
    location: { kind: "local", rootPath },
  });
}

/**
 * Show the OS directory picker dialog.
 * Returns `null` when the user cancels; the selected path otherwise.
 */
export async function pickLocalDirectory(): Promise<string | null> {
  const { canceled, filePaths } = await ipcCall("dialog", "showOpenDirectory", {
    title: "Select workspace folder",
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
}

// ---------------------------------------------------------------------------
// SSH workspace
// ---------------------------------------------------------------------------

export interface CreateSshWorkspaceArgs {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly authMode: "interactive" | "key-only";
  readonly remotePath: string;
  /** When provided, the existing browse-session ControlMaster is reused. */
  readonly sshBrowseSessionId?: string;
}

/**
 * Create and connect an SSH workspace, returning an IpcResult so the caller
 * can branch on `result.ok` (cancelled auth, typed failure, or success).
 */
export async function createSshWorkspace(
  args: CreateSshWorkspaceArgs,
): Promise<IpcResult<WorkspaceMeta>> {
  return ipcCallResult("workspace", "createAndConnect", {
    location: {
      kind: "ssh",
      host: args.host,
      user: args.user,
      port: args.port,
      identityFile: args.identityFile,
      authMode: args.authMode,
      remotePath: args.remotePath,
    },
    sshBrowseSessionId: args.sshBrowseSessionId,
  });
}

// ---------------------------------------------------------------------------
// SSH config hosts
// ---------------------------------------------------------------------------

/**
 * Fetch ~/.ssh/config host entries for the new-connection form combobox.
 * Returns an empty array on error.
 */
export async function listSshConfigHosts(): Promise<
  Awaited<ReturnType<typeof ipcCall<"ssh", "listConfigHosts">>>
> {
  return ipcCall("ssh", "listConfigHosts", undefined);
}
