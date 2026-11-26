import {
  isAbsoluteOutsidePath,
  isDevicePath,
  isNetworkOrDevicePath,
} from "../../../../shared/fs/outside-url";
import type {
  DirEntry,
  FileReadBinaryResult,
  FileReadResult,
  FsStat,
} from "../../../../shared/fs/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import { type FsIpcErrorResult, fsCallError } from "../../../infra/ipc-router/fs-errors";
import type { WorkspaceManager } from "../../workspace/manager";
import type { FsProvider } from "../bridge/provider";
import {
  isOutsideGranted,
  isWindowsNetworkPath,
  pickedNetworkFile,
  resolveOutsideGrant,
  setOutsideGrant,
} from "../outside-grants";
import { isGuardedPeerViewFile } from "../read-guard";

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
      const expected = fsCallError(error);
      if (expected) return expected;
      throw error;
    }
  };
}

export function statHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FsStat | FsIpcErrorResult> {
  return async (args: unknown): Promise<FsStat | FsIpcErrorResult> => {
    const { workspaceId, relPath, followSymlink } = validateArgs(c.stat.args, args);
    const fs = await manager.getFs(workspaceId);
    try {
      return await fs.stat(relPath, followSymlink && !isGuardedPeerViewFile(workspaceId, relPath));
    } catch (error) {
      const expected = fsCallError(error);
      if (expected) return expected;
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
    if (isGuardedPeerViewFile(workspaceId, relPath)) {
      if (!fs.readFileNoLinks) throw new Error("secure file reads are unavailable");
      return fs.readFileNoLinks(relPath);
    }
    return fs.readFile(relPath);
  };
}

async function grantedOutsidePath(
  fs: FsProvider,
  workspaceId: string,
  relPath: string,
): Promise<string | null> {
  if (fs.kind === "local") return resolveOutsideGrant(workspaceId, relPath);
  return isOutsideGranted(workspaceId, relPath) ? relPath : null;
}

export function readBinaryHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FileReadBinaryResult> {
  return async (args: unknown): Promise<FileReadBinaryResult> => {
    const { workspaceId, relPath } = validateArgs(c.readBinary.args, args);
    if (isWindowsNetworkPath(relPath)) return { kind: "missing", reason: "not-found" };
    const fs = await manager.getFs(workspaceId);
    if (isAbsoluteOutsidePath(relPath)) {
      const path = await grantedOutsidePath(fs, workspaceId, relPath);
      if (!path) return { kind: "missing", reason: "not-found" };
      return fs.readAbsoluteBinary(path);
    }
    if (isGuardedPeerViewFile(workspaceId, relPath)) {
      if (!fs.readBinaryNoLinks) throw new Error("secure file reads are unavailable");
      return fs.readBinaryNoLinks(relPath);
    }
    return fs.readBinary(relPath);
  };
}

export function readRangeHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FileReadBinaryResult> {
  return async (args: unknown): Promise<FileReadBinaryResult> => {
    const { workspaceId, relPath, offset, length } = validateArgs(c.readRange.args, args);
    if (isWindowsNetworkPath(relPath)) return { kind: "missing", reason: "not-found" };
    const fs = await manager.getFs(workspaceId);
    if (isAbsoluteOutsidePath(relPath)) {
      const path = await grantedOutsidePath(fs, workspaceId, relPath);
      if (!path) return { kind: "missing", reason: "not-found" };
      return fs.readAbsoluteRange(path, offset, length);
    }
    if (isGuardedPeerViewFile(workspaceId, relPath)) {
      if (!fs.readRangeNoLinks) throw new Error("secure file reads are unavailable");
      return fs.readRangeNoLinks(relPath, offset, length);
    }
    return fs.readRange(relPath, offset, length);
  };
}

export function grantOutsideHandler(): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, owner, files, dirs } = validateArgs(c.grantOutside.args, args);
    setOutsideGrant(workspaceId, owner, files, dirs);
  };
}

export function outsideExistsHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<boolean> {
  return async (args: unknown): Promise<boolean> => {
    const { workspaceId, absolutePath } = validateArgs(c.outsideExists.args, args);
    if (
      !isAbsoluteOutsidePath(absolutePath) ||
      isNetworkOrDevicePath(absolutePath) ||
      absolutePath.includes("\0")
    ) {
      return false;
    }
    const fs = await manager.getFs(workspaceId);
    const read = await fs.readAbsoluteRange(absolutePath, 0, 0).catch(() => null);
    return read !== null && read.kind !== "missing";
  };
}

export function readExternalHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FileReadResult> {
  return async (args: unknown): Promise<FileReadResult> => {
    const { workspaceId, absolutePath } = validateArgs(c.readExternal.args, args);
    if (isDevicePath(absolutePath) || absolutePath.includes("\0")) {
      return { kind: "missing", reason: "not-found" };
    }
    const path = isWindowsNetworkPath(absolutePath)
      ? pickedNetworkFile(absolutePath)
      : absolutePath;
    if (path === undefined) return { kind: "missing", reason: "not-found" };
    const fs = await manager.getFs(workspaceId);
    return fs.readAbsolute(path);
  };
}
