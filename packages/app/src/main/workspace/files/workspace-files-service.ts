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
  EditorBridgeEvent,
  WorkspaceFileCreateRequest,
  WorkspaceFileCreateResult,
  WorkspaceFileDeleteRequest,
  WorkspaceFileDeleteResult,
  WorkspaceFileKind,
  WorkspaceFileReadRequest,
  WorkspaceFileReadResult,
  WorkspaceFileRenameRequest,
  WorkspaceFileRenameResult,
  WorkspaceFileTreeNode,
  WorkspaceFileTreeReadRequest,
  WorkspaceFileTreeReadResult,
  WorkspaceFileWatchChangeKind,
  WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult,
  WorkspaceGitBadge,
  WorkspaceGitBadgesChangedEvent,
  WorkspaceGitBadgesReadRequest,
  WorkspaceGitBadgesReadResult,
  WorkspaceGitBadgeStatus,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type {
  WorkspaceId,
  WorkspaceRegistry,
} from "../../../../../shared/src/contracts/workspace/workspace";
import {
  resolveWorkspaceFilePath,
  toWorkspaceRelativePath,
  type ResolvedWorkspaceFilePath,
} from "./workspace-files-paths";
import { normalizeWorkspaceAbsolutePath } from "../persistence/workspace-persistence";

export type WorkspaceFilesExecFileResult = {
  stdout: string;
  stderr: string;
};

export type WorkspaceFilesExecFile = (
  file: string,
  args: readonly string[],
) => Promise<WorkspaceFilesExecFileResult>;

export interface WorkspaceFilesWatchHandle {
  close(): void;
}

export type WorkspaceFilesWatchFactory = (
  workspaceRoot: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => WorkspaceFilesWatchHandle;

export interface WorkspaceFilesDisposable {
  dispose(): void;
}

export interface WorkspaceFilesWorkspaceRegistryStore {
  getWorkspaceRegistry(): Promise<WorkspaceRegistry>;
}

export interface WorkspaceFilesServiceOptions {
  workspacePersistenceStore: WorkspaceFilesWorkspaceRegistryStore;
  execFile?: WorkspaceFilesExecFile;
  watchFactory?: WorkspaceFilesWatchFactory | null;
  now?: () => Date;
  ignoredTreeNames?: readonly string[];
  fs?: Partial<WorkspaceFilesFileSystem>;
}

export interface WorkspaceFilesFileSystem {
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

const execFileAsync = promisify(execFileCallback) as unknown as WorkspaceFilesExecFile;
const DEFAULT_IGNORED_TREE_NAMES = [".git", "node_modules"];

export class WorkspaceFilesService {
  private readonly workspacePersistenceStore: WorkspaceFilesWorkspaceRegistryStore;
  private readonly execFile: WorkspaceFilesExecFile;
  private readonly watchFactory: WorkspaceFilesWatchFactory | null;
  private readonly now: () => Date;
  private readonly ignoredTreeNames: ReadonlySet<string>;
  private readonly fs: WorkspaceFilesFileSystem;
  private readonly eventListeners = new Set<(event: EditorBridgeEvent) => void>();
  private readonly workspaceWatchers = new Map<WorkspaceId, WorkspaceFilesWatchHandle>();

  public constructor(options: WorkspaceFilesServiceOptions) {
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

  public onEvent(listener: (event: EditorBridgeEvent) => void): WorkspaceFilesDisposable {
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
    request: WorkspaceFileTreeReadRequest,
  ): Promise<WorkspaceFileTreeReadResult> {
    const workspaceRoot = await this.resolveWorkspaceRootAndEnsureWatch(request.workspaceId);
    const treeRoot = resolveWorkspaceFilePath(workspaceRoot, request.rootPath ?? "", {
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
      type: "workspace-files/tree/read/result",
      workspaceId: request.workspaceId,
      rootPath: treeRoot.relativePath,
      nodes,
      readAt: this.timestamp(),
    };
  }

  public async createFile(request: WorkspaceFileCreateRequest): Promise<WorkspaceFileCreateResult> {
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
      type: "workspace-files/file/create/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      kind: request.kind,
      createdAt,
    };
  }

  public async deleteFile(request: WorkspaceFileDeleteRequest): Promise<WorkspaceFileDeleteResult> {
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
      type: "workspace-files/file/delete/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      deletedAt,
    };
  }

  public async renameFile(request: WorkspaceFileRenameRequest): Promise<WorkspaceFileRenameResult> {
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
      type: "workspace-files/file/rename/result",
      workspaceId: request.workspaceId,
      oldPath: oldTarget.relativePath,
      newPath: newTarget.relativePath,
      renamedAt,
    };
  }

  public async readFile(request: WorkspaceFileReadRequest): Promise<WorkspaceFileReadResult> {
    const target = await this.resolveRequestPath(request.workspaceId, request.path, "path");
    await this.assertResolvedPathInsideWorkspace(target, "path");
    const content = await this.fs.readFile(target.absolutePath, "utf8");
    const stats = await this.fs.stat(target.absolutePath);

    return {
      type: "workspace-files/file/read/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      content,
      encoding: "utf8",
      version: versionFromStats(stats),
      readAt: this.timestamp(),
    };
  }

  public async writeFile(request: WorkspaceFileWriteRequest): Promise<WorkspaceFileWriteResult> {
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
      type: "workspace-files/file/write/result",
      workspaceId: request.workspaceId,
      path: target.relativePath,
      encoding: "utf8",
      version: versionFromStats(stats),
      writtenAt,
    };
  }

  public async readGitBadges(
    request: WorkspaceGitBadgesReadRequest,
  ): Promise<WorkspaceGitBadgesReadResult> {
    const workspaceRoot = await this.resolveWorkspaceRootAndEnsureWatch(request.workspaceId);
    const gitBadgeMap = await this.readGitBadgeMap(workspaceRoot);
    const requestedPaths = request.paths?.map((requestPath) =>
      resolveWorkspaceFilePath(workspaceRoot, requestPath, { fieldName: "paths" }).relativePath,
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
      type: "workspace-git-badges/read/result",
      workspaceId: request.workspaceId,
      badges,
      readAt: this.timestamp(),
    };
  }

  private async resolveRequestPath(
    workspaceId: WorkspaceId,
    requestPath: string,
    fieldName: string,
  ): Promise<ResolvedWorkspaceFilePath> {
    const workspaceRoot = await this.resolveWorkspaceRootAndEnsureWatch(workspaceId);
    return resolveWorkspaceFilePath(workspaceRoot, requestPath, { fieldName });
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
    target: ResolvedWorkspaceFilePath,
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
    let watchedPath: ResolvedWorkspaceFilePath;
    try {
      watchedPath = resolveWorkspaceFilePath(workspaceRoot, filenameString, {
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
    gitBadgeMap: ReadonlyMap<string, WorkspaceGitBadgeStatus>,
  ): Promise<WorkspaceFileTreeNode[]> {
    const entries = await this.fs.readdir(directoryPath, { withFileTypes: true });
    const visibleEntries = entries
      .filter((entry) => !this.ignoredTreeNames.has(entry.name))
      .sort(compareDirents);
    const nodes: WorkspaceFileTreeNode[] = [];

    for (const entry of visibleEntries) {
      if (!entry.isDirectory() && !entry.isFile()) {
        continue;
      }

      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
      const stats = await this.fs.lstat(absolutePath);
      const kind: WorkspaceFileKind = entry.isDirectory() ? "directory" : "file";
      const node: WorkspaceFileTreeNode = {
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

  private async readGitBadgeMap(workspaceRoot: string): Promise<Map<string, WorkspaceGitBadgeStatus>> {
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
        type: "workspace-git-badges/read",
        workspaceId,
        paths: [...paths],
      });
      const event: WorkspaceGitBadgesChangedEvent = {
        type: "workspace-git-badges/changed",
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
    kind: WorkspaceFileKind,
    change: WorkspaceFileWatchChangeKind,
    occurredAt: string,
    oldPath?: string,
  ): void {
    this.emitEvent({
      type: "workspace-files/watch",
      workspaceId,
      path: eventPath,
      oldPath: oldPath ?? null,
      kind,
      change,
      occurredAt,
    });
  }

  private emitEvent(event: EditorBridgeEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("workspace files service: event listener failed.", error);
      }
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function parseGitStatusBadges(output: string): Map<string, WorkspaceGitBadgeStatus> {
  const badges = new Map<string, WorkspaceGitBadgeStatus>();

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

export function mapPorcelainStatusToGitBadge(status: string): WorkspaceGitBadgeStatus {
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

function createNativeWatchFactory(): WorkspaceFilesWatchFactory {
  return (workspaceRoot, options, listener): FSWatcher => {
    return watchDefault(workspaceRoot, options, listener);
  };
}

async function assertPathDoesNotExist(
  filePath: string,
  statFn: WorkspaceFilesFileSystem["stat"],
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
  badges: Map<string, WorkspaceGitBadgeStatus>,
  badgePath: string,
  status: WorkspaceGitBadgeStatus,
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
  badges: Map<string, WorkspaceGitBadgeStatus>,
  badgePath: string,
  status: WorkspaceGitBadgeStatus,
): void {
  const currentStatus = badges.get(badgePath);
  if (!currentStatus || gitBadgePriority(status) > gitBadgePriority(currentStatus)) {
    badges.set(badgePath, status);
  }
}

function gitBadgePriority(status: WorkspaceGitBadgeStatus): number {
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

function compareGitBadges(left: WorkspaceGitBadge, right: WorkspaceGitBadge): number {
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
