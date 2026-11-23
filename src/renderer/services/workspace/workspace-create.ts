import type { WorkspaceMeta } from "../../../shared/types/workspace";
import type { IpcResult } from "../../ipc/client";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import type { CallReturn } from "../../ipc/types";

export async function createLocalWorkspace(rootPath: string): Promise<WorkspaceMeta> {
  return unwrapIpcResult(
    await ipcCallResult("workspace", "create", {
      location: { kind: "local", rootPath },
    }),
  );
}

export async function pickLocalDirectory(): Promise<string | null> {
  const { canceled, filePaths } = unwrapIpcResult(
    await ipcCallResult("dialog", "showOpenDirectory", {}),
  );
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
}

export interface CreateSshWorkspaceArgs {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly authMode: "interactive" | "key-only";
  readonly remotePath: string;
  readonly sshBrowseSessionId?: string;
}

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

export async function listSshConfigHosts(): Promise<CallReturn<"ssh", "listConfigHosts">> {
  return unwrapIpcResult(await ipcCallResult("ssh", "listConfigHosts", undefined));
}
