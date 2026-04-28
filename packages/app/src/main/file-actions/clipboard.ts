import {
  constants as fsConstants,
  copyFile as copyFileDefault,
  cp as cpDefault,
  lstat as lstatDefault,
  mkdir as mkdirDefault,
  realpath as realpathDefault,
  rename as renameDefault,
  rm as rmDefault,
  stat as statDefault,
} from "node:fs/promises";
import path from "node:path";

import type { WorkspaceId, WorkspaceRegistry } from "../../../../shared/src/contracts/workspace/workspace";
import { FILE_EXTERNAL_DRAG_LARGE_FILE_THRESHOLD_BYTES } from "../../common/file-actions";
import type {
  FileClipboardEntry,
  FileClipboardOperation,
  FileExternalDragInAppliedEntry,
  FileExternalDragInRequest,
  FileExternalDragInResult,
  FileExternalDragInSkippedEntry,
  FileExternalDragInSource,
  FileExternalDragLargeFile,
  FilePasteAppliedEntry,
  FilePasteCollision,
  FilePasteConflictStrategy,
  FilePasteRequest,
  FilePasteResult,
  FilePasteSkippedEntry,
} from "../../common/file-actions";
import type { WorkspaceFileKind } from "../../../../shared/src/contracts/editor/editor-bridge";
import { resolveWorkspaceFilePath } from "../workspace/files/workspace-files-paths";

export interface FileClipboardWorkspaceRegistryStore {
  getWorkspaceRegistry(): Promise<WorkspaceRegistry>;
}

export interface FileClipboardFileSystem {
  copyFile(source: string, destination: string, flags?: number): Promise<void>;
  cp(source: string, destination: string, options: { recursive: boolean; errorOnExist: boolean; force: boolean }): Promise<void>;
  lstat(filePath: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  mkdir(filePath: string, options?: { recursive?: boolean }): Promise<unknown>;
  realpath(filePath: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  rm(filePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(filePath: string): Promise<unknown>;
}

export interface FileClipboardServiceOptions {
  workspaceRegistryStore: FileClipboardWorkspaceRegistryStore;
  fs?: Partial<FileClipboardFileSystem>;
}

interface ResolvedClipboardEntry extends FileClipboardEntry {
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
}

interface ResolvedPasteTarget {
  workspaceId: WorkspaceId;
  workspaceRoot: string;
  absoluteDirectoryPath: string;
  relativeDirectoryPath: string;
}

interface DestinationPlan {
  entry: ResolvedClipboardEntry;
  absolutePath: string;
  relativePath: string;
  collision: boolean;
}

interface ResolvedExternalDropSource extends FileExternalDragInSource {
  kind: WorkspaceFileKind;
}

interface ExternalDropDestinationPlan {
  source: ResolvedExternalDropSource;
  absolutePath: string;
  relativePath: string;
  collision: boolean;
}

export class FileClipboardService {
  private readonly workspaceRegistryStore: FileClipboardWorkspaceRegistryStore;
  private readonly fs: FileClipboardFileSystem;

  public constructor(options: FileClipboardServiceOptions) {
    this.workspaceRegistryStore = options.workspaceRegistryStore;
    this.fs = {
      copyFile: options.fs?.copyFile ?? copyFileDefault,
      cp: options.fs?.cp ?? cpDefault,
      lstat: options.fs?.lstat ?? lstatDefault,
      mkdir: options.fs?.mkdir ?? mkdirDefault,
      realpath: options.fs?.realpath ?? realpathDefault,
      rename: options.fs?.rename ?? renameDefault,
      rm: options.fs?.rm ?? rmDefault,
      stat: options.fs?.stat ?? statDefault,
    };
  }

  public async paste(request: FilePasteRequest): Promise<FilePasteResult> {
    if (request.entries.length === 0) {
      return emptyPasteResult(request);
    }

    const conflictStrategy = request.conflictStrategy ?? "prompt";
    const registry = await this.workspaceRegistryStore.getWorkspaceRegistry();
    const target = await this.resolvePasteTarget(registry, request.workspaceId, request.targetDirectory);
    const entries = await Promise.all(
      request.entries.map((entry) => this.resolveEntry(registry, entry)),
    );
    const plannedDestinations = await this.planDestinations(target, entries, request.operation, conflictStrategy);
    const collisions = plannedDestinations
      .filter((plan) => plan.collision)
      .map((plan): FilePasteCollision => ({
        sourcePath: plan.entry.relativePath,
        targetPath: plan.relativePath,
        kind: plan.entry.kind,
      }));

    if (collisions.length > 0 && conflictStrategy === "prompt") {
      return {
        type: "file-actions/clipboard/paste/result",
        workspaceId: request.workspaceId,
        operation: request.operation,
        applied: [],
        collisions,
        skipped: [],
      };
    }

    const applied: FilePasteAppliedEntry[] = [];
    const skipped: FilePasteSkippedEntry[] = [];

    for (const plan of plannedDestinations) {
      if (plan.collision && conflictStrategy === "skip") {
        skipped.push({
          sourcePath: plan.entry.relativePath,
          targetPath: plan.relativePath,
          reason: "conflict",
        });
        continue;
      }

      if (isSameFilesystemPath(plan.entry.absolutePath, plan.absolutePath)) {
        skipped.push({
          sourcePath: plan.entry.relativePath,
          targetPath: plan.relativePath,
          reason: "same-path",
        });
        continue;
      }

      await this.applyPastePlan(plan, request.operation, conflictStrategy);
      applied.push({
        sourceWorkspaceId: plan.entry.workspaceId,
        sourcePath: plan.entry.relativePath,
        targetWorkspaceId: target.workspaceId,
        targetPath: plan.relativePath,
        kind: plan.entry.kind,
        operation: request.operation,
      });
    }

    return {
      type: "file-actions/clipboard/paste/result",
      workspaceId: request.workspaceId,
      operation: request.operation,
      applied,
      collisions: [],
      skipped,
    };
  }

  private async resolvePasteTarget(
    registry: WorkspaceRegistry,
    workspaceId: WorkspaceId,
    targetDirectory: string | null,
  ): Promise<ResolvedPasteTarget> {
    const workspaceRoot = resolveWorkspaceRoot(registry, workspaceId);
    const target = resolveWorkspaceFilePath(workspaceRoot, targetDirectory ?? "", {
      allowRoot: true,
      fieldName: "targetDirectory",
    });
    const stats = await this.fs.lstat(target.absolutePath);
    if (!stats.isDirectory()) {
      throw new Error("targetDirectory must resolve to a directory.");
    }
    await this.assertInsideWorkspace(target.workspaceRoot, target.absolutePath, "targetDirectory");

    return {
      workspaceId,
      workspaceRoot: target.workspaceRoot,
      absoluteDirectoryPath: target.absolutePath,
      relativeDirectoryPath: target.relativePath,
    };
  }

  private async resolveEntry(
    registry: WorkspaceRegistry,
    entry: FileClipboardEntry,
  ): Promise<ResolvedClipboardEntry> {
    const workspaceRoot = resolveWorkspaceRoot(registry, entry.workspaceId);
    const resolved = resolveWorkspaceFilePath(workspaceRoot, entry.path, {
      fieldName: "entry.path",
    });
    const stats = await this.fs.lstat(resolved.absolutePath);
    const actualKind: WorkspaceFileKind = stats.isDirectory() ? "directory" : "file";
    if (actualKind !== entry.kind) {
      throw new Error(`Clipboard entry kind mismatch for ${entry.path}.`);
    }
    await this.assertInsideWorkspace(resolved.workspaceRoot, resolved.absolutePath, "entry.path");

    return {
      ...entry,
      workspaceRoot: resolved.workspaceRoot,
      absolutePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
    };
  }

  private async planDestinations(
    target: ResolvedPasteTarget,
    entries: readonly ResolvedClipboardEntry[],
    operation: FileClipboardOperation,
    conflictStrategy: FilePasteConflictStrategy,
  ): Promise<DestinationPlan[]> {
    const planned: DestinationPlan[] = [];
    const occupiedDestinationPaths = new Set<string>();

    for (const entry of entries) {
      const baseName = basenameForWorkspacePath(entry.relativePath);
      const initialAbsolutePath = path.join(target.absoluteDirectoryPath, baseName);
      assertPasteDestinationIsValid(entry, initialAbsolutePath, operation);

      const initialRelativePath = relativePathWithinWorkspace(target.workspaceRoot, initialAbsolutePath);
      const collision = await pathExists(initialAbsolutePath, this.fs.stat);
      let absolutePath = initialAbsolutePath;
      let relativePath = initialRelativePath;

      if ((collision || occupiedDestinationPaths.has(absolutePath)) && conflictStrategy === "keep-both") {
        absolutePath = await this.nextAvailableDestination(target.absoluteDirectoryPath, baseName, occupiedDestinationPaths);
        relativePath = relativePathWithinWorkspace(target.workspaceRoot, absolutePath);
      }

      occupiedDestinationPaths.add(absolutePath);
      planned.push({
        entry,
        absolutePath,
        relativePath,
        collision,
      });
    }

    return planned;
  }

  private async nextAvailableDestination(
    targetDirectory: string,
    baseName: string,
    reservedPaths: ReadonlySet<string>,
  ): Promise<string> {
    return nextAvailableUnderscoreDestination(
      targetDirectory,
      baseName,
      reservedPaths,
      this.fs.stat,
    );
  }

  private async applyPastePlan(
    plan: DestinationPlan,
    operation: FileClipboardOperation,
    conflictStrategy: FilePasteConflictStrategy,
  ): Promise<void> {
    if (plan.collision && conflictStrategy === "replace") {
      await this.fs.rm(plan.absolutePath, { recursive: true, force: true });
    }

    await this.fs.mkdir(path.dirname(plan.absolutePath), { recursive: true });

    if (operation === "cut") {
      await this.moveEntry(plan.entry, plan.absolutePath);
      return;
    }

    if (plan.entry.kind === "directory") {
      await this.fs.cp(plan.entry.absolutePath, plan.absolutePath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      return;
    }

    await this.fs.copyFile(plan.entry.absolutePath, plan.absolutePath, fsConstants.COPYFILE_EXCL);
  }

  private async moveEntry(entry: ResolvedClipboardEntry, destinationPath: string): Promise<void> {
    try {
      await this.fs.rename(entry.absolutePath, destinationPath);
    } catch (error) {
      if (!isCrossDeviceRenameError(error)) {
        throw error;
      }

      if (entry.kind === "directory") {
        await this.fs.cp(entry.absolutePath, destinationPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      } else {
        await this.fs.copyFile(entry.absolutePath, destinationPath, fsConstants.COPYFILE_EXCL);
      }
      await this.fs.rm(entry.absolutePath, { recursive: entry.kind === "directory", force: false });
    }
  }

  private async assertInsideWorkspace(
    workspaceRoot: string,
    absolutePath: string,
    fieldName: string,
  ): Promise<void> {
    await assertInsideWorkspace(this.fs, workspaceRoot, absolutePath, fieldName);
  }
}

export class ExternalFileDropService {
  private readonly workspaceRegistryStore: FileClipboardWorkspaceRegistryStore;
  private readonly fs: FileClipboardFileSystem;

  public constructor(options: FileClipboardServiceOptions) {
    this.workspaceRegistryStore = options.workspaceRegistryStore;
    this.fs = {
      copyFile: options.fs?.copyFile ?? copyFileDefault,
      cp: options.fs?.cp ?? cpDefault,
      lstat: options.fs?.lstat ?? lstatDefault,
      mkdir: options.fs?.mkdir ?? mkdirDefault,
      realpath: options.fs?.realpath ?? realpathDefault,
      rename: options.fs?.rename ?? renameDefault,
      rm: options.fs?.rm ?? rmDefault,
      stat: options.fs?.stat ?? statDefault,
    };
  }

  public async copyIntoWorkspace(request: FileExternalDragInRequest): Promise<FileExternalDragInResult> {
    if (request.files.length === 0) {
      return emptyExternalDragInResult(request);
    }

    const conflictStrategy = request.conflictStrategy ?? "prompt";
    const registry = await this.workspaceRegistryStore.getWorkspaceRegistry();
    const target = await this.resolveDropTarget(registry, request.workspaceId, request.targetDirectory);
    const sources = await Promise.all(request.files.map((source) => this.resolveSource(source)));
    const plans = await this.planDestinations(target, sources, conflictStrategy);
    const collisions = plans
      .filter((plan) => plan.collision)
      .map((plan): FilePasteCollision => ({
        sourcePath: plan.source.absolutePath,
        targetPath: plan.relativePath,
        kind: plan.source.kind,
      }));
    const largeFiles = sources
      .filter((source) => source.size > FILE_EXTERNAL_DRAG_LARGE_FILE_THRESHOLD_BYTES)
      .map((source): FileExternalDragLargeFile => ({
        sourcePath: source.absolutePath,
        size: source.size,
      }));

    if (collisions.length > 0 && conflictStrategy === "prompt") {
      return {
        type: "file-actions/external-drag-in/result",
        workspaceId: request.workspaceId,
        applied: [],
        collisions,
        skipped: [],
        largeFiles,
      };
    }

    const applied: FileExternalDragInAppliedEntry[] = [];
    const skipped: FileExternalDragInSkippedEntry[] = [];

    for (const plan of plans) {
      if (plan.collision && conflictStrategy === "skip") {
        skipped.push({
          sourcePath: plan.source.absolutePath,
          targetPath: plan.relativePath,
          reason: "conflict",
        });
        continue;
      }

      if (isSameFilesystemPath(plan.source.absolutePath, plan.absolutePath)) {
        skipped.push({
          sourcePath: plan.source.absolutePath,
          targetPath: plan.relativePath,
          reason: "same-path",
        });
        continue;
      }

      await this.applyCopyPlan(plan, conflictStrategy);
      applied.push({
        sourcePath: plan.source.absolutePath,
        targetPath: plan.relativePath,
        kind: plan.source.kind,
        size: plan.source.size,
      });
    }

    return {
      type: "file-actions/external-drag-in/result",
      workspaceId: request.workspaceId,
      applied,
      collisions: [],
      skipped,
      largeFiles,
    };
  }

  private async resolveDropTarget(
    registry: WorkspaceRegistry,
    workspaceId: WorkspaceId,
    targetDirectory: string | null,
  ): Promise<ResolvedPasteTarget> {
    const workspaceRoot = resolveWorkspaceRoot(registry, workspaceId);
    const target = resolveWorkspaceFilePath(workspaceRoot, targetDirectory ?? "", {
      allowRoot: true,
      fieldName: "targetDirectory",
    });
    const stats = await this.fs.lstat(target.absolutePath);
    if (!stats.isDirectory()) {
      throw new Error("targetDirectory must resolve to a directory.");
    }
    await assertInsideWorkspace(this.fs, target.workspaceRoot, target.absolutePath, "targetDirectory");

    return {
      workspaceId,
      workspaceRoot: target.workspaceRoot,
      absoluteDirectoryPath: target.absolutePath,
      relativeDirectoryPath: target.relativePath,
    };
  }

  private async resolveSource(source: FileExternalDragInSource): Promise<ResolvedExternalDropSource> {
    if (!path.isAbsolute(source.absolutePath)) {
      throw new Error("External drag source must be an absolute path.");
    }

    const stats = await this.fs.lstat(source.absolutePath);
    const kind: WorkspaceFileKind = stats.isDirectory() ? "directory" : "file";
    return {
      ...source,
      name: source.name || path.basename(source.absolutePath),
      kind,
    };
  }

  private async planDestinations(
    target: ResolvedPasteTarget,
    sources: readonly ResolvedExternalDropSource[],
    conflictStrategy: FilePasteConflictStrategy,
  ): Promise<ExternalDropDestinationPlan[]> {
    const planned: ExternalDropDestinationPlan[] = [];
    const occupiedDestinationPaths = new Set<string>();

    for (const source of sources) {
      const baseName = source.name || path.basename(source.absolutePath);
      const initialAbsolutePath = path.join(target.absoluteDirectoryPath, baseName);
      const initialRelativePath = relativePathWithinWorkspace(target.workspaceRoot, initialAbsolutePath);
      const collision = await pathExists(initialAbsolutePath, this.fs.stat);
      let absolutePath = initialAbsolutePath;
      let relativePath = initialRelativePath;

      if ((collision || occupiedDestinationPaths.has(absolutePath)) && conflictStrategy === "keep-both") {
        absolutePath = await nextAvailableUnderscoreDestination(
          target.absoluteDirectoryPath,
          baseName,
          occupiedDestinationPaths,
          this.fs.stat,
        );
        relativePath = relativePathWithinWorkspace(target.workspaceRoot, absolutePath);
      }

      occupiedDestinationPaths.add(absolutePath);
      planned.push({
        source,
        absolutePath,
        relativePath,
        collision,
      });
    }

    return planned;
  }

  private async applyCopyPlan(
    plan: ExternalDropDestinationPlan,
    conflictStrategy: FilePasteConflictStrategy,
  ): Promise<void> {
    if (plan.collision && conflictStrategy === "replace") {
      await this.fs.rm(plan.absolutePath, { recursive: true, force: true });
    }

    await this.fs.mkdir(path.dirname(plan.absolutePath), { recursive: true });

    if (plan.source.kind === "directory") {
      await this.fs.cp(plan.source.absolutePath, plan.absolutePath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      return;
    }

    await this.fs.copyFile(plan.source.absolutePath, plan.absolutePath, fsConstants.COPYFILE_EXCL);
  }
}

function emptyPasteResult(request: FilePasteRequest): FilePasteResult {
  return {
    type: "file-actions/clipboard/paste/result",
    workspaceId: request.workspaceId,
    operation: request.operation,
    applied: [],
    collisions: [],
    skipped: [],
  };
}

function emptyExternalDragInResult(request: FileExternalDragInRequest): FileExternalDragInResult {
  return {
    type: "file-actions/external-drag-in/result",
    workspaceId: request.workspaceId,
    applied: [],
    collisions: [],
    skipped: [],
    largeFiles: [],
  };
}

function resolveWorkspaceRoot(registry: WorkspaceRegistry, workspaceId: WorkspaceId): string {
  const workspace = registry.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    throw new Error(`Workspace "${workspaceId}" is not registered.`);
  }
  return workspace.absolutePath;
}

function basenameForWorkspacePath(workspacePath: string): string {
  return workspacePath.split("/").filter(Boolean).at(-1) ?? workspacePath;
}

function relativePathWithinWorkspace(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Paste destination cannot traverse outside the workspace.");
  }
  return relative === "" ? "" : relative.split(path.sep).join("/");
}

function assertPasteDestinationIsValid(
  entry: ResolvedClipboardEntry,
  destinationPath: string,
  operation: FileClipboardOperation,
): void {
  if (operation !== "cut" || entry.kind !== "directory") {
    return;
  }

  const relative = path.relative(entry.absolutePath, destinationPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Cannot move a directory into itself or one of its descendants.");
  }
}

function parseFileName(baseName: string): { name: string; ext: string } {
  const ext = path.extname(baseName);
  const name = ext ? baseName.slice(0, -ext.length) : baseName;
  return { name: name || baseName, ext };
}

async function nextAvailableUnderscoreDestination(
  targetDirectory: string,
  baseName: string,
  reservedPaths: ReadonlySet<string>,
  stat: FileClipboardFileSystem["stat"],
): Promise<string> {
  const parsed = parseFileName(baseName);
  for (let index = 2; index < 10_001; index += 1) {
    const candidate = path.join(targetDirectory, `${parsed.name}_${index}${parsed.ext}`);
    if (!reservedPaths.has(candidate) && !(await pathExists(candidate, stat))) {
      return candidate;
    }
  }

  throw new Error(`Unable to choose a non-conflicting name for ${baseName}.`);
}

async function assertInsideWorkspace(
  fs: FileClipboardFileSystem,
  workspaceRoot: string,
  absolutePath: string,
  fieldName: string,
): Promise<void> {
  const realWorkspaceRoot = await fs.realpath(workspaceRoot);
  const realTarget = await fs.realpath(absolutePath).catch(() => absolutePath);
  const relative = path.relative(realWorkspaceRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} cannot traverse outside the workspace.`);
  }
}

async function pathExists(
  absolutePath: string,
  stat: FileClipboardFileSystem["stat"],
): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isSameFilesystemPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isCrossDeviceRenameError(error: unknown): boolean {
  return isNodeErrorCode(error, "EXDEV");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
