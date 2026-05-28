/**
 * removeDir — delete a directory tree.
 *
 * The caller has already confirmed "Delete <folder> and its contents" via
 * `confirmAndDeletePath`, so we go straight to `fs.removeAll` (recursive).
 * Earlier versions tried `fs.rmdir` first and fell back on NOT_EMPTY, but
 * that path produced a noisy "Error occurred in handler for 'ipc:call':
 * NOT_EMPTY" log on every non-empty folder delete even though the operation
 * succeeded via the fallback. `removeAll` handles both empty and non-empty
 * directories, and the agent treats a missing path as a no-op — so this
 * implementation produces no main-process error log on the happy path or on
 * a stale-row race.
 */

import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { loadChildren } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files";
import { relPath } from "@/utils/path";
import { FS_ERROR } from "../../../shared/fs/errors";
import { toFsToast } from "./errors";

export interface RemoveDirInput {
  workspaceId: string;
  workspaceRootPath: string;
  absPath: string;
}

export async function removeDir(input: RemoveDirInput): Promise<boolean> {
  const { workspaceId, workspaceRootPath, absPath } = input;
  const parentAbsPath = parentOf(absPath, workspaceRootPath);
  const rel = relPath(absPath, workspaceRootPath);

  if (rel === absPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: "This path is outside the workspace.",
    });
    return false;
  }

  try {
    unwrapIpcResult(await ipcCallResult("fs", "removeAll", { workspaceId, relPath: rel }));
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: "Couldn't delete folder.",
      notFound: "Folder not found.",
      permissionDenied: "Permission denied while deleting folder.",
      notDirectory: "That path is not a folder.",
    });
    return false;
  }

  await loadChildren(workspaceId, parentAbsPath);
  return true;
}
