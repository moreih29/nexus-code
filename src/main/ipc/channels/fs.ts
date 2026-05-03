import fs from "node:fs";
import path from "node:path";
import { isHiddenName } from "../../../shared/fs-defaults";
import { ipcContract } from "../../../shared/ipc-contract";
import type { DirEntry, FsStat } from "../../../shared/types/fs";
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
    },
    listen: {},
  });
}
