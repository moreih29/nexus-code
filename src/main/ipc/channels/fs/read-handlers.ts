/**
 * Read-only fs handlers — readdir / stat / readFile + the watch
 * lifecycle and the renderer's expanded-folder persistence (which is
 * read-only with respect to *files*, just touches our own SQLite).
 */
import fs from "node:fs";
import path from "node:path";
import {
  BINARY_DETECTION_BYTES,
  isHiddenName,
  MAX_READABLE_FILE_SIZE,
} from "../../../../shared/fs-defaults";
import { FS_ERROR, fsCodeFromErrno, fsErrorMessage } from "../../../../shared/fs-errors";
import { ipcContract } from "../../../../shared/ipc-contract";
import type { DirEntry, FileContent, FsStat } from "../../../../shared/types/fs";
import type { FileWatcher } from "../../../filesystem/file-watcher";
import type { WorkspaceStorage } from "../../../storage/workspace-storage";
import type { WorkspaceManager } from "../../../workspace/workspace-manager";
import { validateArgs } from "../../router";
import { assertWorkspaceExists, resolveSafe } from "./path-safety";

const c = ipcContract.fs.call;

export function watchHandler(
  manager: WorkspaceManager,
  watcher: FileWatcher,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.watch.args, args);
    // resolveSafe throws if workspace not found or path escapes root
    const absDir = resolveSafe(manager, workspaceId, relPath);
    const workspaceRoot = manager.list().find((w) => w.id === workspaceId)?.rootPath;
    if (!workspaceRoot) throw new Error(`workspace not found: ${workspaceId}`);
    watcher.watch(workspaceId, workspaceRoot, absDir);
  };
}

export function unwatchHandler(
  manager: WorkspaceManager,
  watcher: FileWatcher,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.unwatch.args, args);
    const absDir = resolveSafe(manager, workspaceId, relPath);
    watcher.unwatch(workspaceId, absDir);
  };
}

export function readdirHandler(manager: WorkspaceManager): (args: unknown) => Promise<DirEntry[]> {
  return async (args: unknown): Promise<DirEntry[]> => {
    const { workspaceId, relPath } = validateArgs(c.readdir.args, args);
    const abs = resolveSafe(manager, workspaceId, relPath);
    const dirents = await fs.promises.readdir(abs, { withFileTypes: true });
    return dirents
      .filter((d) => !isHiddenName(d.name))
      .map((d) => ({
        name: d.name,
        type: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "file",
      }));
  };
}

export function statHandler(manager: WorkspaceManager): (args: unknown) => Promise<FsStat> {
  return async (args: unknown): Promise<FsStat> => {
    const { workspaceId, relPath } = validateArgs(c.stat.args, args);
    const abs = resolveSafe(manager, workspaceId, relPath);
    const stat = await fs.promises.lstat(abs);
    const type = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "file";
    return {
      type,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      isSymlink: stat.isSymbolicLink(),
    };
  };
}

export function getExpandedHandler(
  manager: WorkspaceManager,
  storage: WorkspaceStorage,
): (args: unknown) => Promise<{ relPaths: string[] }> {
  return async (args: unknown): Promise<{ relPaths: string[] }> => {
    const { workspaceId } = validateArgs(c.getExpanded.args, args);
    assertWorkspaceExists(manager, workspaceId);
    const relPaths = storage.getExpandedPaths(workspaceId);
    return { relPaths };
  };
}

export function setExpandedHandler(
  manager: WorkspaceManager,
  storage: WorkspaceStorage,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPaths } = validateArgs(c.setExpanded.args, args);
    assertWorkspaceExists(manager, workspaceId);
    storage.setExpandedPaths(workspaceId, relPaths);
  };
}

/**
 * Detect whether a buffer is binary and build the appropriate FileContent.
 * Extracted to avoid duplicating the detection logic between readFile and readExternal.
 */
function buildFileContent(buf: Buffer, stat: fs.Stats): FileContent {
  const probe = buf.slice(0, BINARY_DETECTION_BYTES);
  const mtime = stat.mtime.toISOString();

  // UTF-16 LE or BE BOM — treat as binary
  if (
    (probe.length >= 2 && probe[0] === 0xff && probe[1] === 0xfe) ||
    (probe.length >= 2 && probe[0] === 0xfe && probe[1] === 0xff)
  ) {
    return { content: "", encoding: "utf8", sizeBytes: stat.size, isBinary: true, mtime };
  }

  // null-byte binary detection
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0x00) {
      return { content: "", encoding: "utf8", sizeBytes: stat.size, isBinary: true, mtime };
    }
  }

  // UTF-8 BOM detection
  if (probe.length >= 3 && probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf) {
    return {
      content: buf.slice(3).toString("utf8"),
      encoding: "utf8-bom",
      sizeBytes: stat.size,
      isBinary: false,
      mtime,
    };
  }

  return {
    content: buf.toString("utf8"),
    encoding: "utf8",
    sizeBytes: stat.size,
    isBinary: false,
    mtime,
  };
}

export function readFileHandler(
  manager: WorkspaceManager,
): (args: unknown) => Promise<FileContent> {
  return async (args: unknown): Promise<FileContent> => {
    const { workspaceId, relPath } = validateArgs(c.readFile.args, args);
    const abs = resolveSafe(manager, workspaceId, relPath);

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(abs);
    } catch (e: unknown) {
      const code = fsCodeFromErrno((e as NodeJS.ErrnoException).code);
      if (code) throw new Error(fsErrorMessage(code, abs));
      throw e;
    }

    if (stat.isDirectory()) {
      throw new Error(fsErrorMessage(FS_ERROR.IS_DIRECTORY, abs));
    }

    if (stat.size > MAX_READABLE_FILE_SIZE) {
      throw new Error(fsErrorMessage(FS_ERROR.TOO_LARGE, `${abs} (${stat.size} bytes)`));
    }

    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(abs);
    } catch (e: unknown) {
      const code = fsCodeFromErrno((e as NodeJS.ErrnoException).code);
      if (code) throw new Error(fsErrorMessage(code, abs));
      throw e;
    }

    return buildFileContent(buf, stat);
  };
}

export function readExternalHandler(): (args: unknown) => Promise<FileContent> {
  return async (args: unknown): Promise<FileContent> => {
    const { absolutePath } = validateArgs(c.readExternal.args, args);

    if (!path.isAbsolute(absolutePath)) {
      throw new Error(`${FS_ERROR.NOT_FOUND}: path must be absolute: ${absolutePath}`);
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(absolutePath);
    } catch (e: unknown) {
      const code = fsCodeFromErrno((e as NodeJS.ErrnoException).code);
      if (code) throw new Error(fsErrorMessage(code, absolutePath));
      throw e;
    }

    if (stat.isDirectory()) {
      throw new Error(fsErrorMessage(FS_ERROR.IS_DIRECTORY, absolutePath));
    }

    if (stat.size > MAX_READABLE_FILE_SIZE) {
      throw new Error(fsErrorMessage(FS_ERROR.TOO_LARGE, `${absolutePath} (${stat.size} bytes)`));
    }

    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(absolutePath);
    } catch (e: unknown) {
      const code = fsCodeFromErrno((e as NodeJS.ErrnoException).code);
      if (code) throw new Error(fsErrorMessage(code, absolutePath));
      throw e;
    }

    return buildFileContent(buf, stat);
  };
}
