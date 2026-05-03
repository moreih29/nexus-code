import fs from "node:fs";
import path from "node:path";
import { BINARY_DETECTION_BYTES, MAX_READABLE_FILE_SIZE, isHiddenName } from "../../../shared/fs-defaults";
import { ipcContract } from "../../../shared/ipc-contract";
import type { DirEntry, FileContent, FsStat } from "../../../shared/types/fs";
import type { FileWatcher } from "../../filesystem/FileWatcher";
import type { WorkspaceStorage } from "../../storage/workspaceStorage";
import type { WorkspaceManager } from "../../workspace/WorkspaceManager";
import { register, validateArgs } from "../router";

const c = ipcContract.fs.call;

export function watchHandler(
  manager: WorkspaceManager,
  watcher: FileWatcher,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.watch.args, args);
    // resolveSafe throws if workspace not found or path escapes root
    const absDir = resolveSafe(manager, workspaceId, relPath);
    const workspaceRoot = manager.list().find((w) => w.id === workspaceId)!.rootPath;
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

export function resolveSafe(
  manager: WorkspaceManager,
  workspaceId: string,
  relPath: string,
): string {
  const workspace = manager.list().find((w) => w.id === workspaceId);
  if (!workspace) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }

  const rootPath = workspace.rootPath;
  const abs = path.resolve(rootPath, relPath || ".");
  const rel = path.relative(rootPath, abs);

  if (rel === "" || rel === ".") {
    return abs;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes workspace root");
  }

  return abs;
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

function assertWorkspaceExists(manager: WorkspaceManager, workspaceId: string): void {
  if (!manager.list().some((w) => w.id === workspaceId)) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }
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

export function readFileHandler(manager: WorkspaceManager): (args: unknown) => Promise<FileContent> {
  return async (args: unknown): Promise<FileContent> => {
    const { workspaceId, relPath } = validateArgs(c.readFile.args, args);
    const abs = resolveSafe(manager, workspaceId, relPath);

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(abs);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(`NOT_FOUND: ${abs}`);
      if (code === "EACCES") throw new Error(`PERMISSION_DENIED: ${abs}`);
      throw e;
    }

    if (stat.isDirectory()) {
      throw new Error(`IS_DIRECTORY: ${abs}`);
    }

    if (stat.size > MAX_READABLE_FILE_SIZE) {
      throw new Error(`TOO_LARGE: ${abs} (${stat.size} bytes)`);
    }

    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(abs);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(`NOT_FOUND: ${abs}`);
      if (code === "EACCES") throw new Error(`PERMISSION_DENIED: ${abs}`);
      throw e;
    }

    const probe = buf.slice(0, BINARY_DETECTION_BYTES);

    // UTF-16 LE or BE BOM — treat as binary
    if (
      (probe.length >= 2 && probe[0] === 0xff && probe[1] === 0xfe) ||
      (probe.length >= 2 && probe[0] === 0xfe && probe[1] === 0xff)
    ) {
      return { content: "", encoding: "utf8", sizeBytes: stat.size, isBinary: true };
    }

    // null-byte binary detection
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0x00) {
        return { content: "", encoding: "utf8", sizeBytes: stat.size, isBinary: true };
      }
    }

    // UTF-8 BOM detection
    if (probe.length >= 3 && probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf) {
      return {
        content: buf.slice(3).toString("utf8"),
        encoding: "utf8-bom",
        sizeBytes: stat.size,
        isBinary: false,
      };
    }

    return {
      content: buf.toString("utf8"),
      encoding: "utf8",
      sizeBytes: stat.size,
      isBinary: false,
    };
  };
}

export function registerFsChannel(
  manager: WorkspaceManager,
  watcher: FileWatcher,
  storage: WorkspaceStorage,
): void {
  register("fs", {
    call: {
      readdir: readdirHandler(manager),
      stat: statHandler(manager),
      watch: watchHandler(manager, watcher),
      unwatch: unwatchHandler(manager, watcher),
      getExpanded: getExpandedHandler(manager, storage),
      setExpanded: setExpandedHandler(manager, storage),
      readFile: readFileHandler(manager),
    },
    listen: {},
  });
}
