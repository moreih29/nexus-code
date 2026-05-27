/** Rename/move an entry within its current parent via fs.rename. */

import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { loadChildren } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files";
import { basename, relPath } from "@/utils/path";
import { FS_ERROR } from "../../../shared/fs/errors";
import { toFsToast } from "./errors";

export interface RenameInput {
  workspaceId: string;
  workspaceRootPath: string;
  absPath: string;
  newName: string;
}

export async function renamePath(input: RenameInput): Promise<boolean> {
  const parentAbsPath = parentOf(input.absPath, input.workspaceRootPath);
  const trimmedName = input.newName.trim();
  if (trimmedName.length === 0 || trimmedName === basename(input.absPath)) return true;

  const fromRel = relPath(input.absPath, input.workspaceRootPath);
  const toAbsPath = `${parentAbsPath}/${trimmedName}`;
  const toRel = relPath(toAbsPath, input.workspaceRootPath);
  if (fromRel === input.absPath || toRel === toAbsPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: "This path is outside the workspace.",
    });
    return false;
  }

  try {
    unwrapIpcResult(
      await ipcCallResult("fs", "rename", {
        workspaceId: input.workspaceId,
        fromRelPath: fromRel,
        toRelPath: toRel,
      }),
    );
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: "Couldn't rename item.",
      alreadyExists: "A file or folder with that name already exists.",
      crossDevice: "Can't rename across filesystems.",
      notFound: "Item not found.",
      permissionDenied: "Permission denied while renaming item.",
    });
    return false;
  }

  await loadChildren(input.workspaceId, parentAbsPath);
  return true;
}

// ---------------------------------------------------------------------------
// movePath — move an entry to a different parent directory via fs.rename
// ---------------------------------------------------------------------------

export interface MoveInput {
  workspaceId: string;
  workspaceRootPath: string;
  srcAbsPath: string;
  dstDirAbsPath: string;
}

export async function movePath(input: MoveInput): Promise<boolean> {
  const fromRel = relPath(input.srcAbsPath, input.workspaceRootPath);
  const toAbsPath = `${input.dstDirAbsPath}/${basename(input.srcAbsPath)}`;
  const toRel = relPath(toAbsPath, input.workspaceRootPath);

  // Same-directory no-op — the source is already at the destination path.
  if (toRel === fromRel) return true;

  // Workspace boundary check on both source and destination.
  if (fromRel === input.srcAbsPath || toRel === toAbsPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: "This path is outside the workspace.",
    });
    return false;
  }

  try {
    unwrapIpcResult(
      await ipcCallResult("fs", "rename", {
        workspaceId: input.workspaceId,
        fromRelPath: fromRel,
        toRelPath: toRel,
      }),
    );
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: "Couldn't move item.",
      alreadyExists: "A file or folder with that name already exists at the destination.",
      crossDevice: "Can't move across filesystems.",
      notFound: "Item not found.",
      permissionDenied: "Permission denied while moving item.",
    });
    return false;
  }

  // Refresh both the source parent and the destination parent.
  const srcParent = parentOf(input.srcAbsPath, input.workspaceRootPath);
  await loadChildren(input.workspaceId, srcParent);
  if (srcParent !== input.dstDirAbsPath) {
    await loadChildren(input.workspaceId, input.dstDirAbsPath);
  }
  return true;
}
