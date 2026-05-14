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
  GitCherryPickResult,
  GitContinueOpResult,
  GitFastForwardResult,
  GitLogScope,
  GitMarkResolvedResult,
  GitMergeMode,
  GitMergeResult,
  GitCloneStreamProgressEvent,
  GitCloneStreamResultEvent,
  GitRebaseResult,
  GitStatus,
  LogChunk,
  LogComplete,
  PullResult,
  PushResult,
  RemoteTag,
  RepoInfo,
  StashEntry,
  Tag,
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

export interface GitTagListOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GitTagListRemoteOptions {
  readonly cwd: string;
  readonly remote: string;
  readonly signal?: AbortSignal;
}

export interface GitTagCreateOptions {
  readonly cwd: string;
  readonly name: string;
  readonly ref?: string;
  readonly message?: string;
  readonly signal?: AbortSignal;
}

export interface GitTagDeleteOptions {
  readonly cwd: string;
  readonly name: string;
  readonly signal?: AbortSignal;
}

export interface GitTagDeleteRemoteOptions {
  readonly cwd: string;
  readonly remote: string;
  readonly name: string;
  readonly signal?: AbortSignal;
}

export interface GitTagPushOptions {
  readonly cwd: string;
  readonly remote?: string;
  readonly signal?: AbortSignal;
}

export interface GitRemoteAddOptions {
  readonly cwd: string;
  readonly name: string;
  readonly url: string;
  readonly signal?: AbortSignal;
}

export interface GitRemoteRemoveOptions {
  readonly cwd: string;
  readonly name: string;
  readonly signal?: AbortSignal;
}

export interface GitWorkflowMergeOptions {
  readonly cwd: string;
  readonly branch: string;
  readonly mode?: GitMergeMode;
  readonly signal?: AbortSignal;
}

export interface GitWorkflowRebaseOptions {
  readonly cwd: string;
  readonly onto: string;
  readonly signal?: AbortSignal;
}

export interface GitWorkflowCherryPickOptions {
  readonly cwd: string;
  readonly sha: string;
  readonly signal?: AbortSignal;
}

export interface GitWorkflowAbortOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GitWorkflowContinueOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GitConflictMarkResolvedOptions {
  readonly cwd: string;
  readonly relPaths: readonly string[];
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Branch operation option interfaces
// ---------------------------------------------------------------------------

export interface GitBranchCreateOptions {
  readonly cwd: string;
  readonly name: string;
  readonly checkout?: boolean;
  readonly startRef?: string;
  readonly signal?: AbortSignal;
}

export interface GitBranchDeleteOptions {
  readonly cwd: string;
  readonly name: string;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export interface GitBranchDeleteRemoteOptions {
  readonly cwd: string;
  readonly remote: string;
  readonly name: string;
  readonly signal?: AbortSignal;
}

export interface GitBranchRenameOptions {
  readonly cwd: string;
  readonly from: string;
  readonly to: string;
  readonly signal?: AbortSignal;
}

export interface GitBranchSetUpstreamOptions {
  readonly cwd: string;
  readonly branch: string;
  /** null unsets the upstream; a string sets it to the given remote/ref. */
  readonly upstream: string | null;
  readonly signal?: AbortSignal;
}

export interface GitBranchFastForwardOptions {
  readonly cwd: string;
  readonly branch: string;
  readonly remote: string;
  readonly remoteRef: string;
  readonly signal?: AbortSignal;
}

export interface GitCloneOptions {
  readonly url: string;
  readonly parentDir: string;
  readonly name?: string;
  readonly branch?: string;
  readonly recurseSubmodules?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface GitPullOptions {
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface GitPushOptions {
  readonly cwd: string;
  readonly force?: boolean;
  readonly publish?: boolean;
  readonly args?: readonly string[];
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
  tagList?(options: GitTagListOptions): Promise<Tag[]>;
  tagListRemote?(options: GitTagListRemoteOptions): Promise<RemoteTag[]>;
  tagCreate?(options: GitTagCreateOptions): Promise<void>;
  tagDelete?(options: GitTagDeleteOptions): Promise<void>;
  tagDeleteRemote?(options: GitTagDeleteRemoteOptions): Promise<void>;
  tagPush?(options: GitTagPushOptions): Promise<void>;
  remoteAdd?(options: GitRemoteAddOptions): Promise<void>;
  remoteRemove?(options: GitRemoteRemoveOptions): Promise<void>;
  workflowMerge?(options: GitWorkflowMergeOptions): Promise<GitMergeResult>;
  workflowRebase?(options: GitWorkflowRebaseOptions): Promise<GitRebaseResult>;
  workflowCherryPick?(options: GitWorkflowCherryPickOptions): Promise<GitCherryPickResult>;
  workflowAbort?(options: GitWorkflowAbortOptions): Promise<void>;
  workflowContinue?(options: GitWorkflowContinueOptions): Promise<GitContinueOpResult>;
  conflictMarkResolved?(options: GitConflictMarkResolvedOptions): Promise<GitMarkResolvedResult>;
  branchCreate?(options: GitBranchCreateOptions): Promise<void>;
  branchDelete?(options: GitBranchDeleteOptions): Promise<void>;
  branchDeleteRemote?(options: GitBranchDeleteRemoteOptions): Promise<void>;
  branchRename?(options: GitBranchRenameOptions): Promise<void>;
  branchSetUpstream?(options: GitBranchSetUpstreamOptions): Promise<void>;
  branchFastForward?(options: GitBranchFastForwardOptions): Promise<GitFastForwardResult>;
  clone?(
    options: GitCloneOptions,
  ): AsyncGenerator<GitCloneStreamProgressEvent, GitCloneStreamResultEvent, unknown>;
  pull?(options: GitPullOptions): Promise<PullResult>;
  push?(options: GitPushOptions): Promise<PushResult>;
  info?(): Promise<{ binaryPath: string; binaryVersion: string } | null>;
  detect?(options: GitDetectOptions): Promise<RepoInfo>;
}

export interface GitDetectOptions {
  readonly cwd: string;
}
