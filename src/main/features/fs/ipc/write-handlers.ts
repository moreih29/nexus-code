/**
 * Write fs handlers — thin IPC adapters over the workspace's agent-backed
 * filesystem provider.
 */

import type { WriteFileResult } from "../../../../shared/fs/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { WorkspaceManager } from "../../workspace/manager";

const c = ipcContract.fs.call;

export function writeFileHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<WriteFileResult> {
  return async (args: unknown): Promise<WriteFileResult> => {
    const { workspaceId, relPath, content, expected } = validateArgs(c.writeFile.args, args);
    const fs = await manager.getFs(workspaceId);
    return fs.writeFile(relPath, content, expected);
  };
}

export function createFileHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.createFile.args, args);
    const fs = await manager.getFs(workspaceId);
    await fs.createFile(relPath);
  };
}

export function mkdirHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.mkdir.args, args);
    const fs = await manager.getFs(workspaceId);
    await fs.mkdir(relPath);
  };
}

export function unlinkHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.unlink.args, args);
    const fs = await manager.getFs(workspaceId);
    await fs.unlink(relPath);
  };
}

export function rmdirHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.rmdir.args, args);
    const fs = await manager.getFs(workspaceId);
    await fs.rmdir(relPath);
  };
}

export function renameHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, fromRelPath, toRelPath, overwrite } = validateArgs(c.rename.args, args);
    const fs = await manager.getFs(workspaceId);
    await fs.rename(fromRelPath, toRelPath, overwrite);
  };
}

export function copyFileHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, fromRelPath, toRelPath, overwrite } = validateArgs(c.copyFile.args, args);
    const fs = await manager.getFs(workspaceId);
    await fs.copyFile(fromRelPath, toRelPath, overwrite);
  };
}

export function removeAllHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.removeAll.args, args);
    const fs = await manager.getFs(workspaceId);
    await fs.removeAll(relPath);
  };
}
