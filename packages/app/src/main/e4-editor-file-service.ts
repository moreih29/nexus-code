import { execFile as execFileCallback } from "node:child_process";
import { watch as watchDefault, type FSWatcher, type Stats } from "node:fs";
import {
  mkdir as mkdirDefault,
  lstat as lstatDefault,
  readdir as readdirDefault,
  readFile as readFileDefault,
  realpath as realpathDefault,
  rename as renameDefault,
  rm as rmDefault,
  stat as statDefault,
  writeFile as writeFileDefault,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  E4EditorEvent,
  E4FileCreateRequest,
  E4FileCreateResult,
  E4FileDeleteRequest,
  E4FileDeleteResult,
  E4FileKind,
  E4FileReadRequest,
  E4FileReadResult,
  E4FileRenameRequest,
  E4FileRenameResult,
  E4FileTreeNode,
  E4FileTreeReadRequest,
  E4FileTreeReadResult,
  E4FileWatchChangeKind,
  E4FileWriteRequest,
  E4FileWriteResult,
  E4GitBadge,
  E4GitBadgesChangedEvent,
  E4GitBadgesReadRequest,
  E4GitBadgesReadResult,
  E4GitBadgeStatus,
} from "../../../shared/src/contracts/e4-editor";
import type {
  WorkspaceId,
  WorkspaceRegistry,
} from "../../../shared/src/contracts/workspace";
import {
  resolveE4WorkspacePath,
  toWorkspaceRelativePath,
  type E4ResolvedWorkspacePath,
} from "./e4-editor-paths";
import { normalizeWorkspaceAbsolutePath } from "./workspace-persistence";

export type E4EditorExecFileResult = {
  stdout: string;
  stderr: string;
};

export type E4EditorExecFile = (
  file: string,
  args: readonly string[],
) => Promise<E4EditorExecFileResult>;

export interface E4EditorWatchHandle {
  close(): void;
}

export type E4EditorWatchFactory = (
  workspaceRoot: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => E4EditorWatchHandle;

export interface E4EditorDisposable {
  dispose(): void;
}

export interface E4EditorWorkspaceRegistryStore {
  getWorkspaceRegistry(): Promise<WorkspaceRegistry>;
}

export interface E4EditorFileServiceOptions {
  workspacePersistenceStore: E4EditorWorkspaceRegistryStore;
  execFile?: E4EditorExecFile;
  watchFactory?: E4EditorWatchFactory | null;
  now?: () => Date;
  ignoredTreeNames?: readonly string[];
  fs?: Partial<E4EditorFileSystem>;
}

export interface E4EditorFileSystem {
  readdir(filePath: string, options: { withFileTypes: true }): Promise<DirentLike[]>;
  stat(filePath: string): Promise<Stats>;
  lstat(filePath: string): Promise<Stats>;
  realpath(filePath: string): Promise<string>;
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  writeFile(
    filePath: string,
    data: string,
    options?: BufferEncoding | { encoding?: BufferEncoding; flag?: string },
  ): Promise<void>;
  mkdir(filePath: string, options?: { recursive?: boolean }): Promise<unknown>;
  rm(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

const execFileAsync = promisify(execFileCallback) as unknown as E4EditorExecFile;
const DEFAULT_IGNORED_TREE_NAMES = [".git", "node_modules"];

export class E4EditorFileService {
  private readonly workspacePersistenceStore: E4EditorWorkspaceRegistryStore;
  private readonly execFile: E4EditorExecFile;
  private readonly watchFactory: E4EditorWatchFactory | null;
  private readonly now: () => Date;
  private readonly ignoredTreeNames: ReadonlySet<string>;
  private readonly fs: E4EditorFileSystem;
  private readonly eventListeners = new Set<(event: E4EditorEvent) => void>();
  private readonly workspaceWatchers = new Map<WorkspaceId, E4EditorWatchHandle>();

  public constructor(options: E4EditorFileServiceOptions) {
    this.workspacePersistenceStore = options.workspacePersistenceStore;
    this.execFile = options.execFile ?? execFileAsync;
    this.watchFactory = options.watchFactory === undefined
      ? createNativeWatchFactory()
      : options.watchFactory;
    this.now = options.now ?? (() => new Date());
    this.ignoredTreeNames = new Set(options.ignoredTreeNames ?? DEFAULT_IGNORED_TREE_NAMES);
    this.fs = {
      readdir: options.fs?.readdir ?? readdirDefault,
      stat: options.fs?.stat ?? statDefault,
      lstat: options.fs?.lstat ?? lstatDefault,
      realpath: options.fs?.realpath ?? realpathDefault,
      readFile: options.fs?.readFile ?? readFileDefault,
      writeFile: options.fs?.writeFile ?? writeFileDefault,
      mkdir: options.fs?.mkdir ?? mkdirDefault,
      rm: options.fs?.rm ?? rmDefault,
      rename: options.fs?.rename ?? renameDefault,
    };
  }

  public onEvent(listener: (event: E4EditorEvent) => void): E4EditorDisposable {
    this.eventListeners.add(listener);
    return {
      dispose: () => {
        this.eventListeners.delete(listener);
      },
    };
  }

  public dispose(): void {
    for (const watcher of this.workspaceWatchers.values()) {
      watcher.close();
    }
    this.workspaceWatchers.clear();
    this.eventListeners.clear();
  }

  public async readFileTree(
    request: E4FileTreeReadRequest,
  ): Promise<E4FileTreeReadResult> {
    const workspaceRoot = await this.resolveWorkspaceRootAndEnsureWatch(request.workspaceId);
    const treeRoot = resolveE4WorkspacePath(workspaceRoot, request.rootPath ?? "", {
      allowRoot: true,
      fieldName: "rootPath",
    });
    await this.assertResolvedPathInsideWorkspace(treeRoot, "rootPath");
    const treeRootStat = await this.fs.lstat(treeRoot.absolutePath);
    if (!treeRootStat.isDirectory()) {
      throw new Error("rootPath must resolve to a directory.");
    }

    const gitBadges = await this.readGitBadgeMap(workspaceRoot);
    const nodes = await this.scanDirectory(treeRoot.absolutePath, workspaceRoot, gitBadges);

    return {
      type: "e4/file-tree/read/result",
      workspaceId: request.workspaceId,
      rootPath: treeRoot.relativePath,
      nodes,
      readAt: this.timestamp(),
    };
  }

  public async createFile(request: E4FileCreateRequest): Promise<E4FileCreateResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");
    await this.assertResolvedPathInsideWorkspace(target, "path", { allowMissing: true });
    const createdAt = this.timestamp();

    if (request.kind === "directory") {
      await this.fs.mkdir(target.absolutePath, { recursive: true });
    } else {
      await this.fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
      await this.fs.writeFile(target.absolutePath, request.content ?? "", {
        encoding: "utf8",
        flag: request.overwrite ? "w" : "wx",
      });
    }

    this.emitFileWatchEvent(
      request.workspaceId,
      target.relativePath,
      request.kind,
      "created",
      createdAt,
    );
    await this.emitGitBadgesChanged(request.workspaceId, [target.relativePath]);

    return {
      type: "e4/file/create/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      kind: request.kind,
      createdAt,
    };
  }

  public async deleteFile(request: E4FileDeleteRequest): Promise<E4FileDeleteResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");
    await this.assertResolvedPathInsideWorkspace(target, "path");
    const stats = await this.fs.stat(target.absolutePath);
    const kind = stats.isDirectory() ? "directory" : "file";
    await this.fs.rm(target.absolutePath, {
      recursive: request.recursive ?? false,
      force: false,
    });
    const deletedAt = this.timestamp();

    this.emitFileWatchEvent(
      request.workspaceId,
      target.relativePath,
      kind,
      "deleted",
      deletedAt,
    );
    await this.emitGitBadgesChanged(request.workspaceId, [target.relativePath]);

    return {
      type: "e4/file/delete/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      deletedAt,
    };
  }

  public async renameFile(request: E4FileRenameRequest): Promise<E4FileRenameResult> {
    const oldTarget = await this.resolveRequestPath(
      request.workspaceId,
      request.oldPath,
      "oldPath",
    );
    const newTarget = await this.resolveRequestPath(
      request.workspaceId,
      request.newPath,
      "newPath",
    );
    await this.assertResolvedPathInsideWorkspace(oldTarget, "oldPath");
    await this.assertResolvedPathInsideWorkspace(newTarget, "newPath", {
      allowMissing: true,
    });
    const oldStats = await this.fs.stat(oldTarget.absolutePath);
    const kind = oldStats.isDirectory() ? "directory" : "file";

    if (!request.overwrite) {
      await assertPathDoesNotExist(newTarget.absolutePath, this.fs.stat);
    }

    await this.fs.mkdir(path.dirname(newTarget.absolutePath), { recursive: true });
    await this.fs.rename(oldTarget.absolutePath, newTarget.absolutePath);
    const renamedAt = this.timestamp();

    this.emitFileWatchEvent(
      request.workspaceId,
      newTarget.relativePath,
      kind,
      "renamed",
      renamedAt,
      oldTarget.relativePath,
    );
    await this.emitGitBadgesChanged(request.workspaceId, [
      oldTarget.relativePath,
      newTarget.relativePath,
    ]);

    return {
      type: "e4/file/rename/result",
      workspaceId: request.workspaceId,
      oldPath: oldTarget.relativePath,
      newPath: newTarget.relativePath,
      renamedAt,
    };
  }

  public async readFile(request: E4FileReadRequest): Promise<E4FileReadResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");
    await this.assertResolvedPathInsideWorkspace(target, "path");
    const content = await this.fs.readFile(target.absolutePath, "utf8");
    const stats = await this.fs.stat(target.absolutePath);

    return {
      type: "e4/file/read/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      content,
      encoding: "utf8",
      version: versionFromStats(stats),
      readAt: this.timestamp(),
    };
  }

  public async writeFile(request: E4FileWriteRequest): Promise<E4FileWriteResult> {
    if (request.encoding && request.encoding !== "utf8") {
      throw new Error(`Unsupported file encoding: ${request.encoding}`);
    }

    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");
    await this.assertResolvedPathInsideWorkspace(target, "path", { allowMissing: true });
    if (request.expectedVersion) {
      const currentStats = await this.fs.stat(target.absolutePath);
      const currentVersion = versionFromStats(currentStats);
      if (currentVersion !== request.expectedVersion) {
        throw new Error("File version conflict.");
      }
    }

    await this.fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
    await this.fs.writeFile(target.absolutePath, request.content, "utf8");
    const stats = await this.fs.stat(target.absolutePath);
    const writtenAt = this.timestamp();

    this.emitFileWatchEvent(
      request.workspaceId,
      target.relativePath,
      "file",
      "changed",
      writtenAt,
    );
    await this.emitGitBadgesChanged(request.workspaceId, [target.relativePath]);

    return {
      type: "e4/file/write/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      encoding: "utf8",
      version: versionFromStats(stats),
      writtenAt,
    };
  }

  public async readGitBadges(
    request: E4GitBadgesReadRequest,
  ): Promise<E4GitBadgesReadResult> {
    const workspaceRoot = await this.resolveWorkspaceRootAndEnsureWatch(request.workspaceId);
    const gitBadgeMap = await this.readGitBadgeMap(workspaceRoot);
    const requestedPaths = request.paths?.map((requestPath) =>
      resolveE4WorkspacePath(workspaceRoot, requestPath, { fieldName: "paths" }).relativePath,
    );
    const badges = requestedPaths
      ? requestedPaths.map((requestPath) => ({
          path: requestPath,
          status: gitBadgeMap.get(requestPath) ?? "clean",
        }))
      : Array.from(gitBadgeMap.entries(), ([badgePath, status]) => ({
          path: badgePath,
          status,
        })).sort(compareGitBadges);

    return {
      type: "e4/git-badges/read/result",
      workspaceId: request.workspaceId,
      badges,
      readAt: this.timestamp(),
    };
  }

  private async resolveRequestPath(
    workspaceId: WorkspaceId,
    requestPath: string,
    fieldName: string,
  ): Promise<E4ResolvedWorkspacePath> {
    const workspaceRoot = await this.resolveWorkspaceRootAndEnsureWatch(workspaceId);
    return resolveE4WorkspacePath(workspaceRoot, requestPath, { fieldName });
  }

  private async resolveWorkspaceRootAndEnsureWatch(workspaceId: WorkspaceId): Promise<string> {
    const workspaceRoot = await this.resolveWorkspaceRoot(workspaceId);
    this.ensureWorkspaceWatch(workspaceId, workspaceRoot);
    return workspaceRoot;
  }

  private async resolveWorkspaceRoot(workspaceId: WorkspaceId): Promise<string> {
    const registry = await this.workspacePersistenceStore.getWorkspaceRegistry();
    const workspace = registry.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) {
      throw new Error(`Workspace "${workspaceId}" is not registered.`);
    }

    return normalizeWorkspaceAbsolutePath(workspace.absolutePath);
  }

  private async assertResolvedPathInsideWorkspace(
    target: E4ResolvedWorkspacePath,
    fieldName: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<void> {
    const workspaceRealPath = await this.fs.realpath(target.workspaceRoot);
    const targetRealPath = await this.resolveRealPath(target.absolutePath, options);
    assertRealPathInsideWorkspace(workspaceRealPath, targetRealPath, fieldName);
  }

  private async resolveRealPath(
    absolutePath: string,
    options: { allowMissing?: boolean },
  ): Promise<string> {
    try {
      return await this.fs.realpath(absolutePath);
    } catch (error) {
      if (options.allowMissing && isErrnoException(error) && error.code === "ENOENT") {
        return this.resolveNearestExistingParentRealPath(absolutePath);
      }
      throw error;
    }
  }

  private async resolveNearestExistingParentRealPath(absolutePath: string): Promise<string> {
    const parentPath = path.dirname(absolutePath);
    if (parentPath === absolutePath) {
      return absolutePath;
    }

    try {
      return await this.fs.realpath(parentPath);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return this.resolveNearestExistingParentRealPath(parentPath);
      }
      throw error;
    }
  }

  private ensureWorkspaceWatch(workspaceId: WorkspaceId, workspaceRoot: string): void {
    if (!this.watchFactory || this.workspaceWatchers.has(workspaceId)) {
      return;
    }

    const listener = (eventType: string, filename: string | Buffer | null): void => {
      void this.handleNativeWatchEvent(workspaceId, workspaceRoot, eventType, filename);
    };

    try {
      this.workspaceWatchers.set(
        workspaceId,
        this.watchFactory(workspaceRoot, { recursive: true }, listener),
      );
    } catch {
      try {
        this.workspaceWatchers.set(
          workspaceId,
          this.watchFactory(workspaceRoot, { recursive: false }, listener),
        );
      } catch {
        // File watching is opportunistic. IPC file operations still emit deterministic events.
      }
    }
  }

  private async handleNativeWatchEvent(
    workspaceId: WorkspaceId,
    workspaceRoot: string,
    eventType: string,
    filename: string | Buffer | null,
  ): Promise<void> {
    if (!filename) {
      return;
    }

    const filenameString = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
    let watchedPath: E4ResolvedWorkspacePath;
    try {
      watchedPath = resolveE4WorkspacePath(workspaceRoot, filenameString, {
        fieldName: "watch path",
      });
    } catch {
      return;
    }

    const occurredAt = this.timestamp();
    try {
      const stats = await this.fs.lstat(watchedPath.absolutePath);
      if (!stats.isDirectory() && !stats.isFile()) {
        return;
      }
      this.emitFileWatchEvent(
        workspaceId,
        watchedPath.relativePath,
        stats.isDirectory() ? "directory" : "file",
        eventType === "change" ? "changed" : "created",
        occurredAt,
      );
    } catch {
      this.emitFileWatchEvent(
        workspaceId,
        watchedPath.relativePath,
        "file",
        "deleted",
        occurredAt,
      );
    }
  }

  private async scanDirectory(
    directoryPath: string,
    workspaceRoot: string,
    gitBadgeMap: ReadonlyMap<string, E4GitBadgeStatus>,
  ): Promise<E4FileTreeNode[]> {
    const entries = await this.fs.readdir(directoryPath, { withFileTypes: true });
    const visibleEntries = entries
      .filter((entry) => !this.ignoredTreeNames.has(entry.name))
      .sort(compareDirents);
    const nodes: E4FileTreeNode[] = [];

    for (const entry of visibleEntries) {
      if (!entry.isDirectory() && !entry.isFile()) {
        continue;
      }

      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
      const stats = await this.fs.lstat(absolutePath);
      const kind: E4FileKind = entry.isDirectory() ? "directory" : "file";
      const node: E4FileTreeNode = {
        name: entry.name,
        path: relativePath,
        kind,
        modifiedAt: stats.mtime.toISOString(),
        gitBadge: gitBadgeMap.get(relativePath) ?? "clean",
      };

      if (kind === "directory") {
        node.sizeBytes = null;
        node.children = await this.scanDirectory(absolutePath, workspaceRoot, gitBadgeMap);
      } else {
        node.sizeBytes = stats.size;
      }

      nodes.push(node);
    }

    return nodes;
  }

  private async readGitBadgeMap(workspaceRoot: string): Promise<Map<string, E4GitBadgeStatus>> {
    try {
      const status = await this.execFile("git", [
        "-C",
        workspaceRoot,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      return parseGitStatusBadges(status.stdout);
    } catch {
      return new Map();
    }
  }

  private async emitGitBadgesChanged(
    workspaceId: WorkspaceId,
    paths: readonly string[],
  ): Promise<void> {
    try {
      const result = await this.readGitBadges({
        type: "e4/git-badges/read",
        workspaceId,
        paths: [...paths],
      });
      const event: E4GitBadgesChangedEvent = {
        type: "e4/git-badges/changed",
        workspaceId,
        badges: result.badges,
        changedAt: this.timestamp(),
      };
      this.emitEvent(event);
    } catch {
      // File operation results must not fail after a successful fs operation because git is unavailable.
    }
  }

  private emitFileWatchEvent(
    workspaceId: WorkspaceId,
    eventPath: string,
    kind: E4FileKind,
    change: E4FileWatchChangeKind,
    occurredAt: string,
    oldPath?: string,
  ): void {
    this.emitEvent({
      type: "e4/file/watch",
      workspaceId,
      path: eventPath,
      oldPath: oldPath ?? null,
      kind,
      change,
      occurredAt,
    });
  }

  private emitEvent(event: E4EditorEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("E4 editor file service: event listener failed.", error);
      }
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function parseGitStatusBadges(output: string): Map<string, E4GitBadgeStatus> {
  const badges = new Map<string, E4GitBadgeStatus>();

  for (const line of output.split(/\r?\n/)) {
    if (line.length < 3) {
      continue;
    }

    const status = line.slice(0, 2);
    const rawPath = line.slice(3);
    const badgePath = normalizePorcelainPath(rawPath);
    if (!badgePath) {
      continue;
    }

    const badgeStatus = mapPorcelainStatusToGitBadge(status);
    if (badgeStatus === "clean") {
      continue;
    }

    setBadgeWithAncestorPropagation(badges, badgePath, badgeStatus);
  }

  return badges;
}

export function mapPorcelainStatusToGitBadge(status: string): E4GitBadgeStatus {
  if (status === "??") {
    return "untracked";
  }

  const indexStatus = status[0] ?? " ";
  const workTreeStatus = status[1] ?? " ";
  if (indexStatus !== " " && indexStatus !== "?") {
    return "staged";
  }
  if (workTreeStatus !== " ") {
    return "modified";
  }

  return "clean";
}

function createNativeWatchFactory(): E4EditorWatchFactory {
  return (workspaceRoot, options, listener): FSWatcher => {
    return watchDefault(workspaceRoot, options, listener);
  };
}

async function assertPathDoesNotExist(
  filePath: string,
  statFn: E4EditorFileSystem["stat"],
): Promise<void> {
  try {
    await statFn(filePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new Error("Target path already exists.");
}

function normalizePorcelainPath(rawPath: string): string {
  const renameSeparator = " -> ";
  const pathPart = rawPath.includes(renameSeparator)
    ? rawPath.slice(rawPath.lastIndexOf(renameSeparator) + renameSeparator.length)
    : rawPath;

  return pathPart.replace(/^"|"$/g, "").replace(/\\/g, "/");
}

function setBadgeWithAncestorPropagation(
  badges: Map<string, E4GitBadgeStatus>,
  badgePath: string,
  status: E4GitBadgeStatus,
): void {
  const normalizedBadgePath = path.posix.normalize(badgePath.replace(/\\/g, "/"));
  setBadgeIfHigherPriority(badges, normalizedBadgePath, status);

  let parentPath = path.posix.dirname(normalizedBadgePath);
  while (parentPath !== "." && parentPath !== "/") {
    setBadgeIfHigherPriority(badges, parentPath, status);
    parentPath = path.posix.dirname(parentPath);
  }
}

function setBadgeIfHigherPriority(
  badges: Map<string, E4GitBadgeStatus>,
  badgePath: string,
  status: E4GitBadgeStatus,
): void {
  const currentStatus = badges.get(badgePath);
  if (!currentStatus || gitBadgePriority(status) > gitBadgePriority(currentStatus)) {
    badges.set(badgePath, status);
  }
}

function gitBadgePriority(status: E4GitBadgeStatus): number {
  switch (status) {
    case "staged":
      return 40;
    case "modified":
      return 30;
    case "untracked":
      return 20;
    case "clean":
      return 0;
    case "added":
    case "deleted":
    case "renamed":
    case "ignored":
    case "conflicted":
      return 10;
  }
}

function versionFromStats(stats: Stats): string {
  return `mtime:${stats.mtimeMs}:size:${stats.size}`;
}

function compareDirents(left: DirentLike, right: DirentLike): number {
  const leftIsDirectory = left.isDirectory();
  const rightIsDirectory = right.isDirectory();
  if (leftIsDirectory !== rightIsDirectory) {
    return leftIsDirectory ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

function compareGitBadges(left: E4GitBadge, right: E4GitBadge): number {
  return left.path.localeCompare(right.path);
}

function assertRealPathInsideWorkspace(
  workspaceRealPath: string,
  targetRealPath: string,
  fieldName: string,
): void {
  const relativePath = path.relative(workspaceRealPath, targetRealPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${fieldName} cannot traverse outside the workspace.`);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
