// Shared orchestration for fs-mutation operations (new-file, new-folder, etc.).

import { loadChildren } from "@/state/operations/files";
import { relPath } from "@/utils/path";
import { FS_ERROR } from "../../../shared/fs-errors";
import type { FsToastMessages } from "./errors";
import { toFsToast } from "./errors";

export interface FsMutationSpec {
  workspaceId: string;
  workspaceRootPath: string;
  parentAbsPath: string;
  name: string;
  /** Async IPC call to perform. Receives the resolved relative path. */
  ipcAction: (absPath: string, relPath: string) => Promise<unknown>;
  /** Toast messages for the IPC error case. */
  errorMessages: FsToastMessages;
}

/**
 * Runs the standard fs-mutation sequence:
 *   1. Validate that the target path is inside the workspace.
 *   2. Call the IPC action; surface failures as toasts.
 *   3. Merge the parent folder into the tree via loadChildren.
 *
 * Returns false when the mutation fails or is out-of-workspace; true on success.
 * Callers are responsible for any post-success step (e.g. opening the editor).
 */
export async function runFsMutation(spec: FsMutationSpec): Promise<boolean> {
  const absPath = `${spec.parentAbsPath}/${spec.name}`;
  const rel = relPath(absPath, spec.workspaceRootPath);
  if (rel === absPath) {
    toFsToast(new Error(FS_ERROR.OUT_OF_WORKSPACE), {
      fallback: "This path is outside the workspace.",
    });
    return false;
  }

  try {
    await spec.ipcAction(absPath, rel);
  } catch (e: unknown) {
    toFsToast(e, spec.errorMessages);
    return false;
  }

  await loadChildren(spec.workspaceId, spec.parentAbsPath);
  return true;
}
