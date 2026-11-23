import type { FolderBookmark } from "../../../shared/types/entry-points";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";

export async function listFolderBookmarks(): Promise<FolderBookmark[]> {
  const list = unwrapIpcResult(await ipcCallResult("folderBookmark", "list", undefined));
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export interface RecordLocalBookmarkArgs {
  readonly id: string;
  readonly absPath: string;
  readonly label?: string;
}

export async function recordLocalBookmark(args: RecordLocalBookmarkArgs): Promise<void> {
  unwrapIpcResult(
    await ipcCallResult("folderBookmark", "record", {
      id: args.id,
      absPath: args.absPath,
      label: args.label,
      kind: "local",
    }),
  );
}

export interface RecordSshBookmarkArgs {
  readonly id: string;
  readonly absPath: string;
  readonly connectionProfileId: string;
  readonly label?: string;
}

export async function recordSshBookmark(args: RecordSshBookmarkArgs): Promise<void> {
  unwrapIpcResult(
    await ipcCallResult("folderBookmark", "record", {
      id: args.id,
      absPath: args.absPath,
      label: args.label,
      kind: "ssh",
      connectionProfileId: args.connectionProfileId,
    }),
  );
}

export async function setFolderBookmarkFavorite(id: string, favorite: boolean): Promise<void> {
  unwrapIpcResult(await ipcCallResult("folderBookmark", "setFavorite", { id, favorite }));
}

export async function removeFolderBookmark(id: string): Promise<void> {
  unwrapIpcResult(await ipcCallResult("folderBookmark", "remove", { id }));
}
