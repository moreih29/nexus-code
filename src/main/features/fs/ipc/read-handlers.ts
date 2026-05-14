/**
 * Read-only fs handlers — readdir / stat / readFile / readExternal.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { DirEntry, FileReadResult, FsStat } from "../../../../shared/types/fs";
import type { WorkspaceManager } from "../../../workspace/workspace-manager";
import { validateArgs } from "../../../ipc/router";

const c = ipcContract.fs.call;

export function readdirHandler(manager: WorkspaceManager): (args: unknown) => Promise<DirEntry[]> {
  return async (args: unknown): Promise<DirEntry[]> => {
    const { workspaceId, relPath } = validateArgs(c.readdir.args, args);
    return manager.requireContext(workspaceId).fs.readdir(relPath);
  };
}

export function statHandler(manager: WorkspaceManager): (args: unknown) => Promise<FsStat> {
  return async (args: unknown): Promise<FsStat> => {
    const { workspaceId, relPath } = validateArgs(c.stat.args, args);
    return manager.requireContext(workspaceId).fs.stat(relPath);
  };
}

export function readFileHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FileReadResult> {
  return async (args: unknown): Promise<FileReadResult> => {
    const { workspaceId, relPath } = validateArgs(c.readFile.args, args);
    return manager.requireContext(workspaceId).fs.readFile(relPath);
  };
}

export function readExternalHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FileReadResult> {
  return async (args: unknown): Promise<FileReadResult> => {
    const { workspaceId, absolutePath } = validateArgs(c.readExternal.args, args);
    return manager.requireContext(workspaceId).fs.readAbsolute(absolutePath);
  };
}
