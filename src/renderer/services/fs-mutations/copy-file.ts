/**
 * copyPathWithAutoRename — copy a file/folder via `fs.copyFile`, resolving name
 * collisions the way VSCode's explorer paste does: pre-list the destination
 * directory, generate an incremented "copy" name until it is free, then issue
 * one collision-free copy.
 *
 *   copy analysis.html into a folder already holding analysis.html
 *     → writes "analysis copy.html"
 *   copy again → "analysis copy 2.html"
 *
 * The pre-check (readdir) is what makes the noisy "Error occurred in handler
 * for 'ipc:call': ALREADY_EXISTS" main-process log go away: the agent is never
 * asked to write a colliding name in the first place. Other failures still
 * surface a toast.
 */

import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { listDirNames } from "./dir-listing";
import { toFsToast } from "./errors";
import { incrementFileName } from "./increment-name";

export interface CopyFileInput {
  workspaceId: string;
  fromRelPath: string;
  /** Initial workspace-relative destination path (`<dir>/<name>`). */
  toRelPath: string;
  /** True when the source is a directory (affects extension-aware renaming). */
  isFolder?: boolean;
}

/**
 * @returns true when the copy completed, false on error.
 */
export async function copyPathWithAutoRename(input: CopyFileInput): Promise<boolean> {
  const { workspaceId, fromRelPath, isFolder = false } = input;

  const slash = input.toRelPath.lastIndexOf("/");
  const dirRel = slash === -1 ? "" : input.toRelPath.slice(0, slash);
  let name = slash === -1 ? input.toRelPath : input.toRelPath.slice(slash + 1);

  try {
    const existing = await listDirNames(workspaceId, dirRel);
    while (existing.has(name)) {
      name = incrementFileName(name, isFolder);
    }
    const toRelPath = dirRel ? `${dirRel}/${name}` : name;
    unwrapIpcResult(await ipcCallResult("fs", "copyFile", { workspaceId, fromRelPath, toRelPath }));
    return true;
  } catch (e: unknown) {
    toFsToast(e, {
      fallback: "Couldn't copy item.",
      notFound: "Item not found.",
      permissionDenied: "Permission denied while copying item.",
    });
    return false;
  }
}
