import fs from "node:fs";
import { FS_ERROR, fsCodeFromErrno, fsErrorMessage } from "../../../../shared/fs/errors";
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import { getElectronSystemShell, type SystemShell } from "../../shell/open-path";
import { UnsupportedSshWorkspaceError } from "../../workspace/guards";
import type { WorkspaceManager } from "../../workspace/manager";
import { resolveLocalWorkspacePath } from "../../workspace/path-safety";

const c = ipcContract.fs.call;

export function trashHandler(
  manager: WorkspaceManager,
  shellImpl: Pick<SystemShell, "trashItem"> = getElectronSystemShell(),
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.trash.args, args);

    let abs: string;
    try {
      abs = resolveLocalWorkspacePath(manager, workspaceId, relPath, "move to trash");
    } catch (e: unknown) {
      if (e instanceof UnsupportedSshWorkspaceError) {
        throw new Error(fsErrorMessage(FS_ERROR.UNSUPPORTED_REMOTE, workspaceId));
      }
      throw e;
    }

    try {
      await fs.promises.lstat(abs);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      const mapped = fsCodeFromErrno(code);
      if (mapped) throw new Error(fsErrorMessage(mapped, abs));
      throw e;
    }

    try {
      await shellImpl.trashItem(abs);
    } catch (e: unknown) {
      const errno = (e as NodeJS.ErrnoException).code;
      const mapped = fsCodeFromErrno(errno);
      if (mapped) throw new Error(fsErrorMessage(mapped, abs));
      throw new Error(fsErrorMessage(FS_ERROR.PERMISSION_DENIED, abs));
    }
  };
}
