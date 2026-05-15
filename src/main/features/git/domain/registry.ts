/**
 * Per-workspace registry for lazy Git repository detection. It owns cached
 * RepoInfo state and the GitRepository instance for each workspaceId.
 */
import path from "node:path";
import {
  DEFAULT_GIT_OPERATION_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitStatus,
  type RepoInfo,
} from "../../../../shared/types/git";
import { LocalFsProvider } from "../../fs/bridge/local-provider";
import { isAgentBackedProvider } from "../../fs/bridge/provider";
import { AgentGitExecutor } from "../bridge/agent-executor";
import {
  isLocalWorkspace,
  requireLocalWorkspace,
  requireWorkspace,
} from "../../workspace/guards";
import type { BroadcastFn, WorkspaceManager } from "../../workspace/manager";
import { GitError } from "./error";
import type { GitHelpersIpcManager } from "./helpers/ipc";
import { GitRepository } from "./repository";
import type { StatusCoalescer } from "./status-coalescer";

/** Minimal binary descriptor — path + version carried from agent info. */
export interface GitBinaryInfo {
  readonly path: string;
  readonly version: string;
}

export interface GitRegistryOptions {
  readonly onRepoInfoChanged?: (workspaceId: string, info: RepoInfo) => void;
  readonly coalescer?: StatusCoalescer;
  readonly askpassManager?: GitHelpersIpcManager;
}

export interface GitCloneExecutionContext {
  readonly workspaceId: string;
  readonly bin: GitBinaryInfo;
  readonly cwd: string;
  readonly executor: AgentGitExecutor;
  readonly dispose?: () => void;
}

/**
 * Keeps repository detection and repository instance ownership in one place so
 * IPC handlers, watchers, and future coalescers share the same per-workspace
 * cache.
 */
export class GitRegistry {
  private readonly workspaceManager: WorkspaceManager;
  private readonly broadcast: BroadcastFn;
  private readonly bin: GitBinaryInfo | null;
  private readonly repoInfos = new Map<string, RepoInfo>();
  private readonly repositories = new Map<string, GitRepository>();
  private readonly detections = new Map<string, Promise<GitRepository | null>>();
  /**
   * Cancellation handle for the in-flight detection per workspace. dispose()
   * aborts this so the agent-side `detect` request stops early instead of
   * running to completion against a workspace that no longer exists.
   */
  private readonly detectionAborts = new Map<string, AbortController>();
  private readonly generations = new Map<string, number>();
  private gitUnavailable = false;
  private readonly onRepoInfoChanged?: (workspaceId: string, info: RepoInfo) => void;
  private readonly coalescer?: StatusCoalescer;
  private readonly askpassManager?: GitHelpersIpcManager;

  constructor(
    workspaceManager: WorkspaceManager,
    broadcast: BroadcastFn,
    bin: GitBinaryInfo | null,
    options: GitRegistryOptions = {},
  ) {
    this.workspaceManager = workspaceManager;
    this.broadcast = broadcast;
    this.bin = bin;
    this.onRepoInfoChanged = options.onRepoInfoChanged;
    this.coalescer = options.coalescer;
    this.askpassManager = options.askpassManager;
  }

  /**
   * Returns the cached repository or detects it once. Non-repositories cache
   * their `{ kind: "non-repo" }` result and return null.
   */
  async getOrDetect(workspaceId: string, signal?: AbortSignal): Promise<GitRepository | null> {
    const executor = this.getAgentExecutor(workspaceId);
    this.resolveWorkspaceRoot(workspaceId, "Git repository detection", executor);
    this.requireGitBinary(["rev-parse", "--show-toplevel", "--git-dir"], executor);

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
    const executor = this.getAgentExecutor(workspaceId);
    this.resolveWorkspaceRoot(workspaceId, "Git repository info", executor);

    if ((!this.bin && !executor) || this.gitUnavailable) return { kind: "non-repo" };
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
    const executor = this.getAgentExecutor(workspaceId);
    const workspaceRoot = this.resolveWorkspaceRoot(workspaceId, "Git initialization", executor);
    const bin = this.requireGitBinary(["init"], executor);

    await executor.run({
      bin: bin.path,
      cwd: workspaceRoot,
      args: ["init"],
      interactive: false,
      signal,
    });
    return this.refreshDetection(workspaceId, signal);
  }

  /**
   * Forces repository detection to run again and updates the cached state.
   */
  async refreshDetection(workspaceId: string, signal?: AbortSignal): Promise<RepoInfo> {
    const executor = this.getAgentExecutor(workspaceId);
    this.resolveWorkspaceRoot(workspaceId, "Git repository detection", executor);
    this.requireGitBinary(["rev-parse", "--show-toplevel", "--git-dir"], executor);
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
   * Returns the active/requested local workspace executor used for clone.
   *
   * Clone validates and cleans up the destination via Electron's local
   * filesystem APIs, so SSH workspaces are not routed here — doing so would
   * risk cloning on the remote host while cleaning the local one. Remote
   * clone is handled out-of-band.
   */
  getCloneExecutionContext(workspaceId?: string, destination?: string): GitCloneExecutionContext {
    if (workspaceId) return this.getWorkspaceCloneExecutionContext(workspaceId);

    const activeWorkspaceId = this.workspaceManager.getActiveId();
    const activeWorkspace = activeWorkspaceId
      ? this.workspaceManager.list().find((workspace) => workspace.id === activeWorkspaceId)
      : undefined;
    if (activeWorkspaceId && activeWorkspace && isLocalWorkspace(activeWorkspace)) {
      return this.getWorkspaceCloneExecutionContext(activeWorkspaceId);
    }

    if (!destination || !path.isAbsolute(destination)) {
      throw new GitError("clone-destination-invalid", "Clone destination must be absolute", {
        argv: ["clone", destination ?? ""],
      });
    }

    const cwd = path.resolve(destination);
    const provider = new LocalFsProvider(cwd);
    const executor = new AgentGitExecutor(provider, { askpassManager: this.askpassManager });
    return {
      workspaceId: "local-clone",
      bin: this.requireGitBinary(["clone"], executor),
      cwd,
      executor,
      dispose: () => provider.dispose(),
    };
  }

  private getWorkspaceCloneExecutionContext(workspaceId: string): GitCloneExecutionContext {
    const resolvedWorkspaceId = workspaceId;
    const workspace = requireLocalWorkspace(
      this.workspaceManager,
      resolvedWorkspaceId,
      "Git clone",
    );
    const executor = this.getAgentExecutor(resolvedWorkspaceId);
    return {
      workspaceId: resolvedWorkspaceId,
      bin: this.requireGitBinary(["clone"], executor),
      cwd: workspace.location.rootPath,
      executor,
    };
  }

  /**
   * Aborts queued repository work and removes all registry cache for a workspace.
   */
  dispose(workspaceId: string): void {
    this.bumpGeneration(workspaceId);
    this.disposeRepository(workspaceId);
    this.repoInfos.delete(workspaceId);
    const pendingAbort = this.detectionAborts.get(workspaceId);
    if (pendingAbort) {
      pendingAbort.abort();
      this.detectionAborts.delete(workspaceId);
    }
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
   *
   * A workspace-scoped AbortController is created and chained with the
   * caller's signal so dispose() can abort the underlying agent call rather
   * than just dropping the result on the floor.
   */
  private startDetection(workspaceId: string, signal?: AbortSignal): Promise<GitRepository | null> {
    const executor = this.getAgentExecutor(workspaceId);
    const bin = this.requireGitBinary(["rev-parse", "--show-toplevel", "--git-dir"], executor);
    const generation = this.currentGeneration(workspaceId);

    this.setDetecting(workspaceId);

    const controller = new AbortController();
    this.detectionAborts.set(workspaceId, controller);

    const forwardAbort = (): void => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener("abort", forwardAbort, { once: true });
    }

    const detection = this.detectWorkspace(
      workspaceId,
      bin,
      executor,
      generation,
      controller.signal,
    ).finally(() => {
      signal?.removeEventListener("abort", forwardAbort);
      if (this.detectionAborts.get(workspaceId) === controller) {
        this.detectionAborts.delete(workspaceId);
      }
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
    bin: GitBinaryInfo,
    executor: AgentGitExecutor,
    generation: number,
    signal?: AbortSignal,
  ): Promise<GitRepository | null> {
    const workspaceRoot = this.resolveWorkspaceRoot(
      workspaceId,
      "Git repository detection",
      executor,
    );

    try {
      const info = await executor.detect({ cwd: workspaceRoot });
      if (signal?.aborted) return null;
      if (this.currentGeneration(workspaceId) !== generation) return null;

      if (info.kind === "repo") {
        return this.cacheRepository(workspaceId, info, bin, executor);
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
  private cacheRepository(
    workspaceId: string,
    info: RepoInfo & { kind: "repo" },
    bin: GitBinaryInfo,
    executor: AgentGitExecutor,
  ) {
    const existing = this.repositories.get(workspaceId);
    if (existing && existing.topLevel === info.topLevel && existing.gitDir === info.gitDir) {
      this.setRepoInfo(workspaceId, info);
      return existing;
    }

    this.disposeRepository(workspaceId);
    const repo = new GitRepository(
      workspaceId,
      info.topLevel,
      info.gitDir,
      bin,
      executor,
      executor,
    );
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
   * Looks up a local workspace root through WorkspaceManager's public list().
   */
  private resolveWorkspaceRoot(
    workspaceId: string,
    operation: string,
    executor?: AgentGitExecutor,
  ): string {
    if (executor) {
      return requireWorkspace(this.workspaceManager, workspaceId).rootPath;
    }
    const workspace = requireLocalWorkspace(this.workspaceManager, workspaceId, operation);
    return workspace.location.rootPath;
  }

  /**
   * Returns the process Git binary or throws the typed missing-Git error.
   */
  private requireGitBinary(argv: readonly string[], executor?: AgentGitExecutor): GitBinaryInfo {
    if (executor) return this.bin ?? { path: "git", version: "agent" };
    if (this.bin && !this.gitUnavailable) return this.bin;
    throw new GitError("git-missing", "Git executable not found", { argv });
  }

  private getAgentExecutor(workspaceId: string): AgentGitExecutor {
    const provider = this.workspaceManager.requireContext(workspaceId).fs;
    if (!isAgentBackedProvider(provider) || provider.isAgentAvailable?.() === false) {
      throw new Error("workspace agent provider is not available");
    }
    return new AgentGitExecutor(
      () => {
        const current = this.workspaceManager.requireContext(workspaceId).fs;
        if (!isAgentBackedProvider(current) || current.isAgentAvailable?.() === false) {
          throw new Error("workspace agent provider is not available");
        }
        return current;
      },
      { askpassManager: this.askpassManager, workspaceId },
    );
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
