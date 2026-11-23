import {
  DEFAULT_GIT_OPERATION_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitStatus,
  type RepoInfo,
} from "../../../../shared/git/types";
import { isAgentBackedProvider } from "../../fs/bridge/provider";
import { requireLocalWorkspace, requireWorkspace } from "../../workspace/guards";
import type { BroadcastFn, WorkspaceManager } from "../../workspace/manager";
import { AgentGitExecutor } from "../bridge/agent-executor";
import { GitError } from "./error";
import type { GitHelpersIpcManager } from "./helpers/ipc";
import { GitRepository } from "./repository";
import type { StatusCoalescer } from "./status-coalescer";

export interface GitBinaryInfo {
  readonly path: string;
  readonly version: string;
}

export interface GitRegistryOptions {
  readonly onRepoInfoChanged?: (workspaceId: string, info: RepoInfo) => void;
  readonly coalescer?: StatusCoalescer;
  readonly askpassManager?: GitHelpersIpcManager;
}

export class GitRegistry {
  private readonly workspaceManager: WorkspaceManager;
  private readonly broadcast: BroadcastFn;
  private readonly bin: GitBinaryInfo | null;
  private readonly repoInfos = new Map<string, RepoInfo>();
  private readonly repositories = new Map<string, GitRepository>();
  private readonly detections = new Map<string, Promise<GitRepository | null>>();
  private readonly detectionAborts = new Map<string, AbortController>();
  private readonly generations = new Map<string, number>();
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

  async getOrDetect(workspaceId: string, signal?: AbortSignal): Promise<GitRepository | null> {
    await this.workspaceManager.getFs(workspaceId);
    const executor = this.getAgentExecutor(workspaceId);
    this.resolveWorkspaceRoot(workspaceId, "Git repository detection", executor);
    this.requireGitBinary(["rev-parse", "--show-toplevel", "--git-dir"], executor);

    const cachedRepo = this.repositories.get(workspaceId);
    if (cachedRepo && this.repoInfos.get(workspaceId)?.kind === "repo") {
      return cachedRepo;
    }

    const cachedInfo = this.repoInfos.get(workspaceId);
    if (cachedInfo?.kind === "non-repo" || cachedInfo?.kind === "git-missing") return null;

    const pending = this.detections.get(workspaceId);
    if (pending) return pending;

    return this.startDetection(workspaceId, signal);
  }

  getRepoInfo(workspaceId: string): RepoInfo {
    const executor = this.tryGetAgentExecutor(workspaceId);
    if (!executor) return { kind: "detecting" };
    this.resolveWorkspaceRoot(workspaceId, "Git repository info", executor);

    if (!this.bin && !executor) return { kind: "non-repo" };
    const cachedInfo = this.repoInfos.get(workspaceId);
    if (cachedInfo) return cachedInfo;
    return { kind: "detecting" };
  }

  async reinit(workspaceId: string, signal?: AbortSignal): Promise<RepoInfo> {
    await this.workspaceManager.getFs(workspaceId);
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

  async refreshDetection(workspaceId: string, signal?: AbortSignal): Promise<RepoInfo> {
    await this.workspaceManager.getFs(workspaceId);
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

  async refreshStatus(workspaceId: string, signal?: AbortSignal): Promise<GitStatus> {
    this.coalescer?.markRecentlyRefreshed(workspaceId);
    const repo = await this.getOrDetect(workspaceId, signal);
    const status = repo ? await repo.refreshStatus(signal) : createEmptyGitStatus();
    this.broadcast("git", "statusChanged", { workspaceId, status });
    this.coalescer?.markRecentlyRefreshed(workspaceId);
    return status;
  }

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

  bumpGeneration(workspaceId: string): void {
    this.generations.set(workspaceId, this.currentGeneration(workspaceId) + 1);
  }

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
        this.disposeRepository(workspaceId);
        this.setRepoInfo(workspaceId, { kind: "git-missing" });
      }
      throw error;
    }
  }

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

  private setDetecting(workspaceId: string): void {
    if (this.repoInfos.get(workspaceId)?.kind === "detecting") return;
    this.setRepoInfo(workspaceId, { kind: "detecting" });
  }

  private setRepoInfo(workspaceId: string, info: RepoInfo): void {
    this.repoInfos.set(workspaceId, info);
    this.broadcast("git", "repoInfoChanged", { workspaceId, info });
    this.onRepoInfoChanged?.(workspaceId, info);
  }

  private disposeRepository(workspaceId: string): void {
    const repo = this.repositories.get(workspaceId);
    if (repo) {
      repo.dispose();
      this.repositories.delete(workspaceId);
    }
  }

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

  private requireGitBinary(argv: readonly string[], executor?: AgentGitExecutor): GitBinaryInfo {
    if (executor) return this.bin ?? { path: "git", version: "agent" };
    if (this.bin) return this.bin;
    throw new GitError("git-missing", "Git executable not found", { argv });
  }

  private getAgentExecutor(workspaceId: string): AgentGitExecutor {
    const executor = this.tryGetAgentExecutor(workspaceId);
    if (!executor) {
      throw new Error("workspace agent provider is not available");
    }
    return executor;
  }

  private tryGetAgentExecutor(workspaceId: string): AgentGitExecutor | null {
    const provider = this.workspaceManager.requireContext(workspaceId).fs;
    if (!isAgentBackedProvider(provider) || provider.isAgentAvailable?.() === false) {
      return null;
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

  private currentGeneration(workspaceId: string): number {
    return this.generations.get(workspaceId) ?? 0;
  }
}

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
