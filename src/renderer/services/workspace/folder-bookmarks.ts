/**
 * Folder bookmark service — wraps `folderBookmark` IPC channel.
 *
 * Exposes intent-level functions so components never import ipc/client directly.
 */

import type { FolderBookmark } from "../../../shared/types/entry-points";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Fetch all folder bookmarks, sorted by most-recently-used descending.
 */
export async function listFolderBookmarks(): Promise<FolderBookmark[]> {
  const list = unwrapIpcResult(await ipcCallResult("folderBookmark", "list", undefined));
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

// ---------------------------------------------------------------------------
// Record (upsert)
// ---------------------------------------------------------------------------

export interface RecordLocalBookmarkArgs {
  readonly id: string;
  readonly absPath: string;
  readonly label?: string;
}

/** Upsert a local folder bookmark (updates lastUsedAt). */
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

/** Upsert an SSH folder bookmark (updates lastUsedAt). */
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

// ---------------------------------------------------------------------------
// Favorite toggle
// ---------------------------------------------------------------------------

/** Toggle the favorite flag for a folder bookmark. */
export async function setFolderBookmarkFavorite(id: string, favorite: boolean): Promise<void> {
  unwrapIpcResult(await ipcCallResult("folderBookmark", "setFavorite", { id, favorite }));
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/** Remove a folder bookmark by id. */
export async function removeFolderBookmark(id: string): Promise<void> {
  unwrapIpcResult(await ipcCallResult("folderBookmark", "remove", { id }));
}
