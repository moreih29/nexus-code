/**
 * removeDir — delete a directory, falling back to recursive delete when non-empty.
 *
 * Flow:
 *   1. Try fs.rmdir (empty-directory delete). Success → loadChildren & return.
 *   2. If NOT_EMPTY, try fs.removeAll (recursive delete). Success → loadChildren & return.
 *   3. On any error that isn't NOT_EMPTY on step 1, or any error on step 2: toast & return false.
 */

import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { loadChildren } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files";
import { relPath } from "@/utils/path";
import { FS_ERROR, hasFsErrorCode } from "../../../shared/fs/errors";
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

  // Step 1: try rmdir (empty directory fast path).
  try {
    unwrapIpcResult(
      await ipcCallResult("fs", "rmdir", { workspaceId, relPath: rel }),
    );
    await loadChildren(workspaceId, parentAbsPath);
    return true;
  } catch (e: unknown) {
    if (hasFsErrorCode(e, FS_ERROR.NOT_EMPTY)) {
      // Step 2: fallback to recursive removeAll.
      try {
        unwrapIpcResult(
          await ipcCallResult("fs", "removeAll", { workspaceId, relPath: rel }),
        );
        await loadChildren(workspaceId, parentAbsPath);
        return true;
      } catch (removeAllErr: unknown) {
        toFsToast(removeAllErr, {
          fallback: "Couldn't delete folder.",
          notFound: "Folder not found.",
          permissionDenied: "Permission denied while deleting folder.",
        });
        return false;
      }
    }

    toFsToast(e, {
      fallback: "Couldn't delete folder.",
      notFound: "Folder not found.",
      permissionDenied: "Permission denied while deleting folder.",
    });
    return false;
  }
}