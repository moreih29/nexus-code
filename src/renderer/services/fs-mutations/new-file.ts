/**
 * Create-a-file orchestration.
 *
 * Steps:
 *   1. Compute workspace-relative path from `parentAbsPath` + name.
 *   2. IPC `fs.createFile` (O_EXCL — fails on existing path).
 *   3. Refresh the parent folder so the tree includes the new entry.
 *   4. Open the file in the editor as a non-preview tab.
 *
 * Errors surface as toasts via the shared dispatcher; the function
 * returns a boolean so callers (the inline-edit row) can decide whether
 * to clear pending state or keep the input open for retry.
 */

import { ipcCall } from "@/ipc/client";
import { openOrRevealEditor } from "@/services/editor";
import { loadChildren } from "@/state/operations/files";
import { relPath } from "@/utils/path";
import { FS_ERROR } from "../../../shared/fs-errors";
import { toFsToast } from "./errors";

export interface NewFileInput {
  workspaceId: string;
  workspaceRootPath: string;
  parentAbsPath: string;
  name: string;
}

export async function createNewFile(input: NewFileInput): Promise<boolean> {
  const absPath = `${input.parentAbsPath}/${input.name}`;
  const rel = relPath(absPath, input.workspaceRootPath);
  if (rel === absPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: "This path is outside the workspace.",
    });
    return false;
  }

  try {
    await ipcCall("fs", "createFile", {
      workspaceId: input.workspaceId,
      relPath: rel,
    });
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: "Couldn't create file.",
      alreadyExists: "A file or folder with that name already exists.",
    });
    return false;
  }

  // Eager merge of the parent so the new file shows up without waiting
  // for the watcher. We use loadChildren — not refresh — because refresh
  // wipes all descendant nodes, which would visually collapse any
  // already-expanded sub-trees under this parent (the chevrons stay open
  // but the children disappear until clicked twice).
  await loadChildren(input.workspaceId, input.parentAbsPath);

  // VSCode parity: New File leaves the new file open and focused, as a
  // permanent tab (not preview).
  openOrRevealEditor({ workspaceId: input.workspaceId, filePath: absPath }, { preview: false });

  return true;
}
