/**
 * Read-only fs handlers — readdir / stat / readFile / readBinary / readExternal.
 *
 * readdir/stat catch agent-thrown fs errors (NOT_FOUND, PERMISSION_DENIED, …)
 * and return them as a typed `ipcErr` envelope instead of letting them throw.
 * This keeps Electron's `ipcMain.handle` invocation logger silent for the
 * expected-failure paths — most notably restoring a persisted expanded-tree
 * after the user has deleted folders on disk between sessions.
 */
import type {
  DirEntry,
  FileReadBinaryResult,
  FileReadResult,
  FsStat,
} from "../../../../shared/fs/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { WorkspaceManager } from "../../workspace/manager";
import { isOutsideGranted, resolveOutsideGrant, setOutsideGrant } from "../outside-grants";
import { type FsIpcErrorResult, fsErrorToIpcResult, isFsError } from "./fs-result";

const c = ipcContract.fs.call;

export function readdirHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<DirEntry[] | FsIpcErrorResult> {
  return async (args: unknown): Promise<DirEntry[] | FsIpcErrorResult> => {
    const { workspaceId, relPath, includeHidden } = validateArgs(c.readdir.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      return await fs.readdir(relPath, { includeHidden });
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function statHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FsStat | FsIpcErrorResult> {
  return async (args: unknown): Promise<FsStat | FsIpcErrorResult> => {
    const { workspaceId, relPath } = validateArgs(c.stat.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      return await fs.stat(relPath);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function readFileHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FileReadResult> {
  return async (args: unknown): Promise<FileReadResult> => {
    const { workspaceId, relPath } = validateArgs(c.readFile.args, args);
    const fs = await manager.getFs(workspaceId);
    return fs.readFile(relPath);
  };
}

export function readBinaryHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FileReadBinaryResult> {
  return async (args: unknown): Promise<FileReadBinaryResult> => {
    const { workspaceId, relPath } = validateArgs(c.readBinary.args, args);
    const fs = await manager.getFs(workspaceId);
    // An absolute path is a file outside the workspace a Claude tab linked.
    if (relPath.startsWith("/")) {
      const path =
        fs.kind === "local"
          ? await resolveOutsideGrant(workspaceId, relPath)
          : isOutsideGranted(workspaceId, relPath)
            ? relPath
            : null;
      if (!path) return { kind: "missing", reason: "not-found" };
      return fs.readAbsoluteBinary(path);
    }
    return fs.readBinary(relPath);
  };
}

export function grantOutsideHandler(): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, owner, files, dirs } = validateArgs(c.grantOutside.args, args);
    setOutsideGrant(workspaceId, owner, files, dirs);
  };
}

export function readExternalHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FileReadResult> {
  return async (args: unknown): Promise<FileReadResult> => {
    const { workspaceId, absolutePath } = validateArgs(c.readExternal.args, args);
    const fs = await manager.getFs(workspaceId);
    return fs.readAbsolute(absolutePath);
  };
}
