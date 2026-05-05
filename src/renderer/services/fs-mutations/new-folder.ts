/**
 * Create-a-folder orchestration.
 *
 * Mirrors createNewFile but uses `fs.mkdir` (no editor open). On
 * success the parent is refreshed and the new folder is left
 * unexpanded (matches VSCode — user clicks to drill in).
 */

import { ipcCall } from "@/ipc/client";
import { useFilesStore } from "@/state/stores/files";
import { relPath } from "@/utils/path";
import { toFsToast } from "./errors";

export interface NewFolderInput {
  workspaceId: string;
  workspaceRootPath: string;
  parentAbsPath: string;
  name: string;
}

export async function createNewFolder(input: NewFolderInput): Promise<boolean> {
  const absPath = `${input.parentAbsPath}/${input.name}`;
  const rel = relPath(absPath, input.workspaceRootPath);
  if (rel === absPath) {
    toFsToast(new Error("OUT_OF_WORKSPACE"), {
      fallback: "This path is outside the workspace.",
    });
    return false;
  }

  try {
    await ipcCall("fs", "mkdir", {
      workspaceId: input.workspaceId,
      relPath: rel,
    });
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: "Couldn't create folder.",
      alreadyExists: "A file or folder with that name already exists.",
    });
    return false;
  }

  // See createNewFile: loadChildren merges the new entry into the
  // existing tree without disturbing already-loaded sub-trees.
  await useFilesStore.getState().loadChildren(input.workspaceId, input.parentAbsPath);
  return true;
}
