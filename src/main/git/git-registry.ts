/**
 * Per-workspace registry for lazy Git repository detection. It owns cached
 * RepoInfo state and the GitRepository instance for each workspaceId.
 */
import {
  DEFAULT_GIT_OPERATION_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitStatus,
  type RepoInfo,
} from "../../shared/types/git";
import type { BroadcastFn, WorkspaceManager } from "../workspace/workspace-manager";
import type { GitBinary } from "./git-binary";
import { detectRepository } from "./git-detect";
import { GitError } from "./git-error";
import { runGit } from "./git-process";
import { GitRepository } from "./git-repository";
import type { StatusCoalescer } from "./status-coalescer";

export interface GitRegistryOptions {
  readonly onRepoInfoChanged?: (workspaceId: string, info: RepoInfo) => void;
  readonly coalescer?: StatusCoalescer;
}

/**
 * Keeps repository detection and repository instance ownership in one place so
 * IPC handlers, watchers, and future coalescers share the same per-workspace
 * cache.
 */
export class GitRegistry {
  private readonly workspaceManager: WorkspaceManager;
  private readonly broadcast: BroadcastFn;
  private readonly bin: GitBinary | null;
  private readonly repoInfos = new Map<string, RepoInfo>();
  private readonly repositories = new Map<string, GitRepository>();
  private readonly detections = new Map<string, Promise<GitRepository | null>>();
  private readonly generations = new Map<string, number>();
  private gitUnavailable = false;
  private readonly onRepoInfoChanged?: (workspaceId: string, info: RepoInfo) => void;
  private readonly coalescer?: StatusCoalescer;

  constructor(
    workspaceManager: WorkspaceManager,
    broadcast: BroadcastFn,
    bin: GitBinary | null,
    options: GitRegistryOptions = {},
  ) {
    this.workspaceManager = workspaceManager;
    this.broadcast = broadcast;
    this.bin = bin;
    this.onRepoInfoChanged = options.onRepoInfoChanged;
    this.coalescer = options.coalescer;
  }

  /**
   * Returns the cached repository or detects it once. Non-repositories cache
   * their `{ kind: "non-repo" }` result and return null.
   */
  async getOrDetect(workspaceId: string, signal?: AbortSignal): Promise<GitRepository | null> {
    this.requireGitBinary(["rev-parse", "--show-toplevel", "--git-dir"]);

    const cachedRepo = this.repositories.get(workspaceId);
    if (cachedRepo && this.repoInfos.get(workspaceId)?.kind === "repo") {
      return cachedRepo;
    }

    const cachedInfo = this.repoInfos.get(workspaceId);
    if (cachedInfo?.kind === "non-repo") return null;

    const pending = this.detections.get(workspaceId);
    if (pending) return pending;

    return this.startDetection(workspaceId, signal);
  }

  /**
   * Returns the current cached info without importing renderer-side state.
   */
  getRepoInfo(workspaceId: string): RepoInfo {
    this.resolveWorkspaceRoot(workspaceId);

    if (!this.bin || this.gitUnavailable) return { kind: "non-repo" };
    const cachedInfo = this.repoInfos.get(workspaceId);
    if (cachedInfo) return cachedInfo;
    // Both an in-flight detection and a never-started workspace report as
    // "detecting" so the renderer renders the same skeleton in both cases.
    return { kind: "detecting" };
  }

  /**
   * Initializes a repository at the workspace root, then re-runs detection.
   */
  async reinit(workspaceId: string, signal?: AbortSignal): Promise<RepoInfo> {
    const bin = this.requireGitBinary(["init"]);
    const workspaceRoot = this.resolveWorkspaceRoot(workspaceId);

    await runGit({ bin: bin.path, cwd: workspaceRoot, args: ["init"], signal });
    return this.refreshDetection(workspaceId, signal);
  }

  /**
   * Forces repository detection to run again and updates the cached state.
   */
  async refreshDetection(workspaceId: string, signal?: AbortSignal): Promise<RepoInfo> {
    this.requireGitBinary(["rev-parse", "--show-toplevel", "--git-dir"]);
    this.bumpGeneration(workspaceId);
    this.disposeRepository(workspaceId);
    this.repoInfos.delete(workspaceId);
    this.setDetecting(workspaceId);

    await this.startDetection(workspaceId, signal);
    return this.repoInfos.get(workspaceId) ?? { kind: "non-repo" };
  }

  /**
   * Refreshes status through the repository queue and broadcasts the result.
   */
  async refreshStatus(workspaceId: string, signal?: AbortSignal): Promise<GitStatus> {
    const repo = await this.getOrDetect(workspaceId, signal);
    const status = repo ? await repo.refreshStatus(signal) : createEmptyGitStatus();
    this.broadcast("git", "statusChanged", { workspaceId, status });
    this.coalescer?.markRecentlyRefreshed(workspaceId);
    return status;
  }

  /**
   * Returns the resolved Git executable path for workspace-agnostic operations
   * such as clone, where no GitRepository exists yet.
   */
  getGitBinaryPath(argv: readonly string[]): string {
    return this.requireGitBinary(argv).path;
  }

  /**
   * Aborts queued repository work and removes all registry cache for a workspace.
   */
  dispose(workspaceId: string): void {
    this.bumpGeneration(workspaceId);
    this.disposeRepository(workspaceId);
    this.repoInfos.delete(workspaceId);
    this.detections.delete(workspaceId);
  }

  /**
   * Disposes every known workspace cache owned by the registry.
   */
  disposeAll(): void {
    const workspaceIds = new Set<string>([
      ...this.repoInfos.keys(),
      ...this.repositories.keys(),
      ...this.detections.keys(),
    ]);

    for (const workspaceId of workspaceIds) {
      this.dispose(workspaceId);
    }
  }

  /**
   * Increments the per-workspace token used to ignore stale detections and to
   * mark explicit git mutations that should not rely on watcher coalescing.
   */
  bumpGeneration(workspaceId: string): void {
    this.generations.set(workspaceId, this.currentGeneration(workspaceId) + 1);
  }

  /**
   * Starts the one in-flight detection promise allowed per workspaceId.
   */
  private startDetection(workspaceId: string, signal?: AbortSignal): Promise<GitRepository | null> {
    const bin = this.requireGitBinary(["rev-parse", "--show-toplevel", "--git-dir"]);
    const generation = this.currentGeneration(workspaceId);

    this.setDetecting(workspaceId);

    const detection = this.detectWorkspace(workspaceId, bin, generation, signal).finally(() => {
      if (this.detections.get(workspaceId) === detection) {
        this.detections.delete(workspaceId);
      }
    });

    this.detections.set(workspaceId, detection);
    return detection;
  }

  /**
   * Runs Git detection and commits the result only if the workspace was not
   * disposed while detection was in flight.
   */
  private async detectWorkspace(
    workspaceId: string,
    bin: GitBinary,
    generation: number,
    signal?: AbortSignal,
  ): Promise<GitRepository | null> {
    const workspaceRoot = this.resolveWorkspaceRoot(workspaceId);

    try {
      const info = await detectRepository(workspaceRoot, bin, signal);
      if (this.currentGeneration(workspaceId) !== generation) return null;

      if (info.kind === "repo") {
        return this.cacheRepository(workspaceId, info, bin);
      }

      this.disposeRepository(workspaceId);
      this.setRepoInfo(workspaceId, info);
      return null;
    } catch (error) {
      if (error instanceof GitError && error.kind === "git-missing") {
        this.gitUnavailable = true;
        this.disposeRepository(workspaceId);
        this.setRepoInfo(workspaceId, { kind: "non-repo" });
      }
      throw error;
    }
  }

  /**
   * Installs or replaces the repository instance for a detected repo.
   */
  private cacheRepository(workspaceId: string, info: RepoInfo & { kind: "repo" }, bin: GitBinary) {
    const existing = this.repositories.get(workspaceId);
    if (existing && existing.topLevel === info.topLevel && existing.gitDir === info.gitDir) {
      this.setRepoInfo(workspaceId, info);
      return existing;
    }

    this.disposeRepository(workspaceId);
    const repo = new GitRepository(workspaceId, info.topLevel, info.gitDir, bin);
    this.repositories.set(workspaceId, repo);
    this.setRepoInfo(workspaceId, info);
    return repo;
  }

  /**
   * Records a detecting state and notifies listeners only on state change.
   */
  private setDetecting(workspaceId: string): void {
    if (this.repoInfos.get(workspaceId)?.kind === "detecting") return;
    this.setRepoInfo(workspaceId, { kind: "detecting" });
  }

  /**
   * Updates RepoInfo cache and broadcasts the new value.
   */
  private setRepoInfo(workspaceId: string, info: RepoInfo): void {
    this.repoInfos.set(workspaceId, info);
    this.broadcast("git", "repoInfoChanged", { workspaceId, info });
    this.onRepoInfoChanged?.(workspaceId, info);
  }

  /**
   * Disposes and removes the repository object without touching RepoInfo.
   */
  private disposeRepository(workspaceId: string): void {
    const repo = this.repositories.get(workspaceId);
    if (repo) {
      repo.dispose();
      this.repositories.delete(workspaceId);
    }
  }

  /**
   * Looks up a workspace root through WorkspaceManager's public list().
   */
  private resolveWorkspaceRoot(workspaceId: string): string {
    const workspace = this.workspaceManager
      .list()
      .find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    return workspace.rootPath;
  }

  /**
   * Returns the process Git binary or throws the typed missing-Git error.
   */
  private requireGitBinary(argv: readonly string[]): GitBinary {
    if (this.bin && !this.gitUnavailable) return this.bin;
    throw new GitError("git-missing", "Git executable not found", { argv });
  }

  /**
   * Reads the stale-detection guard token for a workspace.
   */
  private currentGeneration(workspaceId: string): number {
    return this.generations.get(workspaceId) ?? 0;
  }
}

/**
 * Builds the empty status shape used for non-repository workspaces.
 */
function createEmptyGitStatus(): GitStatus {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: null,
    capabilities: { ...DEFAULT_REPO_CAPABILITIES },
    operationState: DEFAULT_GIT_OPERATION_STATE,
    lastFetchedAt: null,
  };
}
