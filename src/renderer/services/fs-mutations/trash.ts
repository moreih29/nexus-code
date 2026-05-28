/**
 * trashPath — move a workspace entry to the OS recycle bin (Local only).
 *
 * The caller (typically `confirmAndDeletePath`) has already verified
 * that the workspace is local and shown the recoverable-delete confirm
 * message. SSH workspaces never reach this code path — they call
 * `removeDir` / `unlinkPath` directly after a "this cannot be undone"
 * confirm — and the main handler will surface UNSUPPORTED_REMOTE if a
 * buggy caller ignores that branch.
 *
 * The main handler is idempotent on ENOENT, so a stale row whose file
 * disappeared between refresh and click resolves silently.
 */

import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { loadChildren } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files";
import { relPath } from "@/utils/path";
import { FS_ERROR } from "../../../shared/fs/errors";
import { toFsToast } from "./errors";

export interface TrashPathInput {
  workspaceId: string;
  workspaceRootPath: string;
  /** Absolute path of the entry to trash. */
  absPath: string;
  /** "file" | "dir" | "symlink" — drives the error toast wording only. */
  nodeType: "file" | "dir" | "symlink";
}

export async function trashPath(input: TrashPathInput): Promise<boolean> {
  const { workspaceId, workspaceRootPath, absPath, nodeType } = input;
  const parentAbsPath = parentOf(absPath, workspaceRootPath);
  const rel = relPath(absPath, workspaceRootPath);

  if (rel === absPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: "This path is outside the workspace.",
    });
    return false;
  }

  const isDir = nodeType === "dir";
  try {
    unwrapIpcResult(await ipcCallResult("fs", "trash", { workspaceId, relPath: rel }));
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: isDir ? "Couldn't move folder to Trash." : "Couldn't move file to Trash.",
      notFound: isDir ? "Folder not found." : "File not found.",
      permissionDenied: isDir
        ? "Permission denied while moving folder to Trash."
        : "Permission denied while moving file to Trash.",
    });
    return false;
  }

  await loadChildren(workspaceId, parentAbsPath);
  return true;
}
