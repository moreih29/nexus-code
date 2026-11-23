import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { WorkspaceManager } from "../../workspace/manager";
import { runFsCall } from "./fs-result";

const c = ipcContract.fs.call;

export function writeFileHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath, content, expected, bytes } = validateArgs(c.writeFile.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.writeFile(relPath, content, expected, bytes);
    });
  };
}

export function createFileHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.createFile.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.createFile(relPath);
    });
  };
}

export function mkdirHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath, recursive } = validateArgs(c.mkdir.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.mkdir(relPath, recursive);
    });
  };
}

export function unlinkHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.unlink.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.unlink(relPath);
    });
  };
}

export function rmdirHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.rmdir.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.rmdir(relPath);
    });
  };
}

export function renameHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, fromRelPath, toRelPath, overwrite } = validateArgs(c.rename.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.rename(fromRelPath, toRelPath, overwrite);
    });
  };
}

export function copyFileHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, fromRelPath, toRelPath, overwrite } = validateArgs(c.copyFile.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.copyFile(fromRelPath, toRelPath, overwrite);
    });
  };
}

export function removeAllHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.removeAll.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.removeAll(relPath);
    });
  };
}
