/** Rename/move an entry within its current parent via fs.rename. */

import { ipcCall } from "@/ipc/client";
import { loadChildren } from "@/state/operations/files";
import { parentOf } from "@/state/stores/files";
import { basename, relPath } from "@/utils/path";
import { FS_ERROR } from "../../../shared/fs/fs-errors";
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
    await ipcCall("fs", "rename", {
      workspaceId: input.workspaceId,
      fromRelPath: fromRel,
      toRelPath: toRel,
    });
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
