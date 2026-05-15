/**
 * Workspace-scoped OS reveal handlers.
 *
 * These are Electron shell integrations, not filesystem operations. They stay
 * in main because remote workspaces cannot be revealed by the local OS shell,
 * and local paths need to be checked before Electron's best-effort API runs.
 */
import fs from "node:fs";
import { fsCodeFromErrno, fsErrorMessage } from "../../../shared/fs/fs-errors";
import { ipcContract } from "../../../shared/ipc/ipc-contract";
import { validateArgs } from "../../infra/ipc-router";
import { resolveLocalWorkspacePath } from "../workspace/path-safety";
import type { WorkspaceManager } from "../workspace/manager";
import { getElectronSystemShell, type SystemShell } from "./open-path";

const c = ipcContract.fs.call;

export function showItemInFolderHandler(
  manager: WorkspaceManager,
  shellImpl: Pick<SystemShell, "showItemInFolder"> = getElectronSystemShell(),
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.showItemInFolder.args, args);
    const abs = resolveLocalWorkspacePath(manager, workspaceId, relPath, "reveal workspace files");

    try {
      await fs.promises.access(abs);
    } catch (e: unknown) {
      const code = fsCodeFromErrno((e as NodeJS.ErrnoException).code);
      if (code) throw new Error(fsErrorMessage(code, abs));
      throw e;
    }

    shellImpl.showItemInFolder(abs);
  };
}
