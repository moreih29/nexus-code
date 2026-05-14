/**
 * Write fs handlers — thin IPC adapters over the workspace's agent-backed
 * filesystem provider.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { WriteFileResult } from "../../../../shared/types/fs";
import { validateArgs } from "../../../ipc/router";
import type { WorkspaceManager } from "../../workspace/manager";

const c = ipcContract.fs.call;

export function writeFileHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<WriteFileResult> {
  return async (args: unknown): Promise<WriteFileResult> => {
    const { workspaceId, relPath, content, expected } = validateArgs(c.writeFile.args, args);
    return manager.requireContext(workspaceId).fs.writeFile(relPath, content, expected);
  };
}

export function createFileHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.createFile.args, args);
    await manager.requireContext(workspaceId).fs.createFile(relPath);
  };
}

export function mkdirHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.mkdir.args, args);
    await manager.requireContext(workspaceId).fs.mkdir(relPath);
  };
}

export function unlinkHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.unlink.args, args);
    await manager.requireContext(workspaceId).fs.unlink(relPath);
  };
}

export function rmdirHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.rmdir.args, args);
    await manager.requireContext(workspaceId).fs.rmdir(relPath);
  };
}

export function renameHandler(manager: WorkspaceManager): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, fromRelPath, toRelPath } = validateArgs(c.rename.args, args);
    await manager.requireContext(workspaceId).fs.rename(fromRelPath, toRelPath);
  };
}
