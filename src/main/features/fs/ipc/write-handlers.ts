/** Write adapters envelope both provider startup and the agent operation. */
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { WorkspaceManager } from "../../workspace/manager";
import { runFsCall } from "./fs-result";

const c = ipcContract.fs.call;

/** Runs the agent's writeFile operation on the selected workspace. */
export function writeFileHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath, content, expected, bytes } = validateArgs(c.writeFile.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.writeFile(relPath, content, expected, bytes);
    });
  };
}

/** Runs the agent's createFile operation on the selected workspace. */
export function createFileHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.createFile.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.createFile(relPath);
    });
  };
}

/** Runs the agent's mkdir operation on the selected workspace. */
export function mkdirHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath, recursive } = validateArgs(c.mkdir.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.mkdir(relPath, recursive);
    });
  };
}

/** Runs the agent's unlink operation on the selected workspace. */
export function unlinkHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.unlink.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.unlink(relPath);
    });
  };
}

/** Runs the agent's rmdir operation on the selected workspace. */
export function rmdirHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.rmdir.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.rmdir(relPath);
    });
  };
}

/** Runs the agent's rename operation on the selected workspace. */
export function renameHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, fromRelPath, toRelPath, overwrite } = validateArgs(c.rename.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.rename(fromRelPath, toRelPath, overwrite);
    });
  };
}

/** Runs the agent's copyFile operation on the selected workspace. */
export function copyFileHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, fromRelPath, toRelPath, overwrite } = validateArgs(c.copyFile.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.copyFile(fromRelPath, toRelPath, overwrite);
    });
  };
}

/** Runs the agent's removeAll operation on the selected workspace. */
export function removeAllHandler(manager: WorkspaceManager) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.removeAll.args, args);
    return runFsCall(async () => {
      const fs = await manager.getFs(workspaceId);
      return fs.removeAll(relPath);
    });
  };
}
