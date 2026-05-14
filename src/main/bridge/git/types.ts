/**
 * Git executor contract shared by repository coordinators and bridge-backed
 * implementations. Electron keeps queueing and UI orchestration; executors own
 * the actual git process on the workspace host.
 */
import type {
  CommitDetail,
  DiffChunk,
  DiffComplete,
  DiffSpec,
  GitBlobChunk,
  GitBlobComplete,
  GitLogScope,
  GitStatus,
  LogChunk,
  LogComplete,
  StashEntry,
} from "../../../shared/types/git";

export interface GitProcessOptions {
  readonly bin: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** True lets caller-provided askpass/editor helpers handle prompts. */
  readonly interactive?: boolean;
  /** True streams stderr chunks instead of stdout while preserving final stderr classification. */
  readonly streamStderr?: boolean;
  readonly signal?: AbortSignal;
}

export interface RunGitOptions extends GitProcessOptions {
  readonly stdoutCapBytes?: number;
}

export interface RunGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface GitStatusOptions {
  readonly cwd: string;
  readonly untracked?: "all" | "normal" | "no";
  readonly renames?: boolean;
  readonly ignored?: boolean;
  readonly signal?: AbortSignal;
}

export interface GitLogOptions {
  readonly cwd: string;
  readonly ref?: string;
  readonly scope?: GitLogScope;
  readonly afterSha?: string;
  readonly grep?: string;
  readonly skip?: number;
  readonly limit?: number;
  readonly paths?: readonly string[];
  readonly source?: boolean;
  readonly signal?: AbortSignal;
}

export interface GitDiffOptions {
  readonly cwd: string;
  readonly spec: DiffSpec;
  readonly context?: number;
  readonly unified?: number;
  readonly maxChunkBytes?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface GitBlobOptions {
  readonly cwd: string;
  readonly ref: string;
  readonly relPath: string;
  readonly maxBytes?: number;
  readonly maxChunkBytes?: number;
  readonly signal?: AbortSignal;
}

export interface GitCommitDetailOptions {
  readonly cwd: string;
  readonly sha: string;
  readonly signal?: AbortSignal;
}

export interface GitStashListOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GitStashApplyOptions {
  readonly cwd: string;
  readonly index: number;
  readonly signal?: AbortSignal;
}

export interface GitStashDropOptions {
  readonly cwd: string;
  readonly index: number;
  readonly signal?: AbortSignal;
}

export interface GitStashPopOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GitStashShowOptions {
  readonly cwd: string;
  readonly index: number;
  readonly maxChunkBytes?: number;
  readonly signal?: AbortSignal;
}

export interface GitStashGroupOptions {
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly message?: string;
  readonly signal?: AbortSignal;
}

export interface GitExecutor {
  run(options: RunGitOptions): Promise<RunGitResult>;
  stream(options: GitProcessOptions): AsyncGenerator<Buffer, void, unknown>;
  status?(options: GitStatusOptions): Promise<GitStatus>;
  log?(options: GitLogOptions): AsyncGenerator<LogChunk, LogComplete, unknown>;
  diff?(options: GitDiffOptions): AsyncGenerator<DiffChunk, DiffComplete, unknown>;
  blob?(options: GitBlobOptions): AsyncGenerator<GitBlobChunk, GitBlobComplete, unknown>;
  commitDetail?(options: GitCommitDetailOptions): Promise<CommitDetail>;
  stashList?(options: GitStashListOptions): Promise<StashEntry[]>;
  stashApply?(options: GitStashApplyOptions): Promise<void>;
  stashDrop?(options: GitStashDropOptions): Promise<void>;
  stashPop?(options: GitStashPopOptions): Promise<void>;
  stashShow?(options: GitStashShowOptions): AsyncGenerator<DiffChunk, DiffComplete, unknown>;
  stashGroup?(options: GitStashGroupOptions): Promise<void>;
}
