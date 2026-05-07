/**
 * Move / reveal fs handlers — operations that *relocate* a path on disk
 * or expose it to the OS.
 *
 * `showItemInFolder` is the only entry today (Reveal in Finder); future
 * additions go here: rename, trashItem.
 */

import fs from "node:fs";
import { shell } from "electron";
import { fsCodeFromErrno, fsErrorMessage } from "../../../../shared/fs-errors";
import { ipcContract } from "../../../../shared/ipc-contract";
import type { WorkspaceManager } from "../../../workspace/workspace-manager";
import { validateArgs } from "../../router";
import { resolveSafe } from "./path-safety";

const c = ipcContract.fs.call;

export function revealInFinderHandler(
  shellImpl: { showItemInFolder: (path: string) => void } = shell,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { absolutePath } = validateArgs(c.revealInFinder.args, args);
    shellImpl.showItemInFolder(absolutePath);
  };
}

export function showItemInFolderHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.showItemInFolder.args, args);
    const abs = resolveSafe(manager, workspaceId, relPath);

    // Confirm the path still exists. Electron's showItemInFolder is a
    // best-effort no-op when the path is gone — surfacing a clear error
    // here lets the renderer toast a message instead of leaving the user
    // wondering why nothing happened.
    try {
      await fs.promises.access(abs);
    } catch (e: unknown) {
      const code = fsCodeFromErrno((e as NodeJS.ErrnoException).code);
      if (code) throw new Error(fsErrorMessage(code, abs));
      throw e;
    }

    shell.showItemInFolder(abs);
  };
}
