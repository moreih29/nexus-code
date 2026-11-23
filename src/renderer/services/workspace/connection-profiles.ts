import type { ConnectionProfile } from "../../../shared/types/entry-points";
import { type IpcResult, ipcCallResult, unwrapIpcResult } from "../../ipc/client";

export async function listConnectionProfiles(): Promise<ConnectionProfile[]> {
  const list = unwrapIpcResult(await ipcCallResult("connectionProfile", "list", undefined));
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export async function fetchConnectionProfiles(): Promise<ConnectionProfile[]> {
  return unwrapIpcResult(await ipcCallResult("connectionProfile", "list", undefined));
}

export interface SaveConnectionProfileArgs {
  readonly id: string;
  readonly host: string;
  readonly user: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly authMode: "interactive" | "key-only";
  readonly label?: string;
}

export async function saveConnectionProfile(args: SaveConnectionProfileArgs): Promise<void> {
  unwrapIpcResult(
    await ipcCallResult("connectionProfile", "save", {
      id: args.id,
      host: args.host,
      user: args.user,
      port: args.port,
      identityFile: args.identityFile,
      authMode: args.authMode,
      label: args.label,
    }),
  );
}

export async function saveConnectionProfileResult(
  args: SaveConnectionProfileArgs,
): Promise<IpcResult<void>> {
  const raw = await ipcCallResult("connectionProfile", "save", {
    id: args.id,
    host: args.host,
    user: args.user,
    port: args.port,
    identityFile: args.identityFile,
    authMode: args.authMode,
    label: args.label,
  });
  return raw as IpcResult<void>;
}

export async function setConnectionProfileFavorite(id: string, favorite: boolean): Promise<void> {
  unwrapIpcResult(await ipcCallResult("connectionProfile", "setFavorite", { id, favorite }));
}

export async function removeConnectionProfile(id: string): Promise<void> {
  unwrapIpcResult(await ipcCallResult("connectionProfile", "remove", { id }));
}
