/* AUTO-GENERATED. DO NOT EDIT. Regenerate via `bun run gen:contracts`. */
import type { WorkspaceId } from "../_brands";


export type GitLifecycleMessage =
  | GitStatusCommand
  | GitBranchListCommand
  | GitCommitCommand
  | GitStageCommand
  | GitUnstageCommand
  | GitDiscardCommand
  | GitCheckoutCommand
  | GitBranchCreateCommand
  | GitBranchDeleteCommand
  | GitDiffCommand
  | GitWatchStartCommand
  | GitWatchStopCommand
  | GitStatusReply
  | GitBranchListReply
  | GitCommitReply
  | GitStageReply
  | GitUnstageReply
  | GitDiscardReply
  | GitCheckoutReply
  | GitBranchCreateReply
  | GitBranchDeleteReply
  | GitDiffReply
  | GitWatchStartedReply
  | GitWatchStoppedReply
  | GitFailedEvent;
export type RequestId = string;
/**
 * NFC-normalized absolute git workspace filesystem path
 */
export type Cwd = string;
/**
 * @minItems 1
 */
export type GitPaths = [GitPath, ...GitPath[]];
/**
 * Workspace-relative path passed to git after -- pathspec termination.
 */
export type GitPath = string;
export type BranchName = string;
export type GitOptionalPaths = GitPath[];
export type WatchId = string;
export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "clean";
export type GitLifecycleAction =
  | "status"
  | "branch_list"
  | "commit"
  | "stage"
  | "unstage"
  | "discard"
  | "checkout"
  | "branch_create"
  | "branch_delete"
  | "diff"
  | "watch_start"
  | "watch_stop"
  | "status_result"
  | "branch_list_result"
  | "commit_result"
  | "stage_result"
  | "unstage_result"
  | "discard_result"
  | "checkout_result"
  | "branch_create_result"
  | "branch_delete_result"
  | "diff_result"
  | "watch_started"
  | "watch_stopped"
  | "failed";
export type GitFailureState = "unavailable" | "error";

export interface GitStatusCommand {
  type: "git/lifecycle";
  action: "status";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
}
export interface GitBranchListCommand {
  type: "git/lifecycle";
  action: "branch_list";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
}
export interface GitCommitCommand {
  type: "git/lifecycle";
  action: "commit";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  message: string;
  amend?: boolean;
}
export interface GitStageCommand {
  type: "git/lifecycle";
  action: "stage";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  paths: GitPaths;
}
export interface GitUnstageCommand {
  type: "git/lifecycle";
  action: "unstage";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  paths: GitPaths;
}
export interface GitDiscardCommand {
  type: "git/lifecycle";
  action: "discard";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  paths: GitPaths;
}
export interface GitCheckoutCommand {
  type: "git/lifecycle";
  action: "checkout";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  ref: string;
}
export interface GitBranchCreateCommand {
  type: "git/lifecycle";
  action: "branch_create";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  name: BranchName;
  startPoint?: string;
}
export interface GitBranchDeleteCommand {
  type: "git/lifecycle";
  action: "branch_delete";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  name: BranchName;
  force: boolean;
}
export interface GitDiffCommand {
  type: "git/lifecycle";
  action: "diff";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  staged: boolean;
  paths: GitOptionalPaths;
}
export interface GitWatchStartCommand {
  type: "git/lifecycle";
  action: "watch_start";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  watchId: WatchId;
  debounceMs?: number;
}
export interface GitWatchStopCommand {
  type: "git/lifecycle";
  action: "watch_stop";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  watchId: WatchId;
}
export interface GitStatusReply {
  type: "git/lifecycle";
  action: "status_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  summary: GitStatusSummary;
  generatedAt: string;
}
export interface GitStatusSummary {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitStatusEntry[];
}
export interface GitStatusEntry {
  path: GitPath;
  /**
   * Previous workspace-relative path for rename/copy entries.
   */
  originalPath: string | null;
  /**
   * Two-column git porcelain v1 XY status.
   */
  status: string;
  indexStatus: string;
  workTreeStatus: string;
  kind: GitFileStatusKind;
}
export interface GitBranchListReply {
  type: "git/lifecycle";
  action: "branch_list_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  branches: GitBranch[];
  generatedAt: string;
}
export interface GitBranch {
  name: BranchName;
  current: boolean;
  upstream: string | null;
  headOid: string | null;
}
export interface GitCommitReply {
  type: "git/lifecycle";
  action: "commit_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  commitOid: string;
  summary: GitStatusSummary;
  completedAt: string;
}
export interface GitStageReply {
  type: "git/lifecycle";
  action: "stage_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  summary: GitStatusSummary;
  completedAt: string;
}
export interface GitUnstageReply {
  type: "git/lifecycle";
  action: "unstage_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  summary: GitStatusSummary;
  completedAt: string;
}
export interface GitDiscardReply {
  type: "git/lifecycle";
  action: "discard_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  summary: GitStatusSummary;
  completedAt: string;
}
export interface GitCheckoutReply {
  type: "git/lifecycle";
  action: "checkout_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  summary: GitStatusSummary;
  completedAt: string;
}
export interface GitBranchCreateReply {
  type: "git/lifecycle";
  action: "branch_create_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  branches: GitBranch[];
  completedAt: string;
}
export interface GitBranchDeleteReply {
  type: "git/lifecycle";
  action: "branch_delete_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  branches: GitBranch[];
  completedAt: string;
}
export interface GitDiffReply {
  type: "git/lifecycle";
  action: "diff_result";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  staged: boolean;
  paths: GitOptionalPaths;
  diff: string;
  generatedAt: string;
}
export interface GitWatchStartedReply {
  type: "git/lifecycle";
  action: "watch_started";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  watchId: WatchId;
  watchedPaths: string[];
  startedAt: string;
}
export interface GitWatchStoppedReply {
  type: "git/lifecycle";
  action: "watch_stopped";
  requestId: RequestId;
  workspaceId: WorkspaceId;
  watchId: WatchId;
  stoppedAt: string;
}
export interface GitFailedEvent {
  type: "git/lifecycle";
  action: "failed";
  failedAction: GitLifecycleAction;
  requestId: RequestId;
  workspaceId: WorkspaceId;
  cwd: Cwd;
  state: GitFailureState;
  message: string;
  exitCode: number | null;
  stderr: string;
  failedAt: string;
}
