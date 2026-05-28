/**
 * Write fs handlers — thin IPC adapters over the workspace's agent-backed
 * filesystem provider.
 *
 * Every handler catches agent-thrown fs errors (ALREADY_EXISTS, NOT_FOUND,
 * PERMISSION_DENIED, IS_DIRECTORY, NOT_EMPTY, …) and returns them as a typed
 * `ipcErr` envelope instead of letting them throw. Without this, Electron's
 * `ipcMain.handle` invocation logger prints
 *   "Error occurred in handler for 'ipc:call': Error: ALREADY_EXISTS: …"
 * on every expected user-facing failure (creating a name that already exists,
 * renaming to a colliding name, deleting a path the watcher hasn't dropped
 * yet, …) — duplicating the toast we already raise in the renderer. The
 * renderer side is unchanged: `unwrapIpcResult` rethrows the envelope as an
 * `Error("CODE: …")` so `toFsToast` keeps classifying it.
 *
 * Mirrors the read/watch handlers, which have used this wrap since they were
 * introduced.
 */

import type { WriteFileResult } from "../../../../shared/fs/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { WorkspaceManager } from "../../workspace/manager";
import { type FsIpcErrorResult, fsErrorToIpcResult, isFsError } from "./fs-result";

const c = ipcContract.fs.call;

export function writeFileHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<WriteFileResult | FsIpcErrorResult> {
  return async (args: unknown): Promise<WriteFileResult | FsIpcErrorResult> => {
    const { workspaceId, relPath, content, expected } = validateArgs(c.writeFile.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      return await fs.writeFile(relPath, content, expected);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function createFileHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<void | FsIpcErrorResult> {
  return async (args: unknown): Promise<void | FsIpcErrorResult> => {
    const { workspaceId, relPath } = validateArgs(c.createFile.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      await fs.createFile(relPath);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function mkdirHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<void | FsIpcErrorResult> {
  return async (args: unknown): Promise<void | FsIpcErrorResult> => {
    const { workspaceId, relPath, recursive } = validateArgs(c.mkdir.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      await fs.mkdir(relPath, recursive);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function unlinkHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<void | FsIpcErrorResult> {
  return async (args: unknown): Promise<void | FsIpcErrorResult> => {
    const { workspaceId, relPath } = validateArgs(c.unlink.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      await fs.unlink(relPath);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function rmdirHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<void | FsIpcErrorResult> {
  return async (args: unknown): Promise<void | FsIpcErrorResult> => {
    const { workspaceId, relPath } = validateArgs(c.rmdir.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      await fs.rmdir(relPath);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function renameHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<void | FsIpcErrorResult> {
  return async (args: unknown): Promise<void | FsIpcErrorResult> => {
    const { workspaceId, fromRelPath, toRelPath, overwrite } = validateArgs(c.rename.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      await fs.rename(fromRelPath, toRelPath, overwrite);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function copyFileHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<void | FsIpcErrorResult> {
  return async (args: unknown): Promise<void | FsIpcErrorResult> => {
    const { workspaceId, fromRelPath, toRelPath, overwrite } = validateArgs(c.copyFile.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      await fs.copyFile(fromRelPath, toRelPath, overwrite);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function removeAllHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<void | FsIpcErrorResult> {
  return async (args: unknown): Promise<void | FsIpcErrorResult> => {
    const { workspaceId, relPath } = validateArgs(c.removeAll.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      await fs.removeAll(relPath);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}
