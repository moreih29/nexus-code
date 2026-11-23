import type {
  BranchInfo,
  BranchList,
  CommitResult,
  GitActionHint,
  GitAutofetchError,
  GitAutofetchIntervalMin,
  GitCommitOptions,
  GitContinueOpResult,
  GitExpandedGroupKey,
  GitExpandedGroups,
  GitExpandedTreeNodes,
  GitFastForwardResult,
  GitFetchAllResult,
  GitHistoryScope,
  GitMarkResolvedResult,
  GitMergeMode,
  GitMergeResult,
  GitPanelSegment,
  GitPanelStateUpdate,
  GitRebaseResult,
  GitStatus,
  GitSyncError,
  GitSyncResult,
  LogEntry,
  PullResult,
  PushResult,
  RemoteTag,
  RepoInfo,
  StashEntry,
  Tag,
} from "../../../../shared/git/types";
import type { ViewMode } from "../../../../shared/types/panel";

export type {
  BranchInfo,
  BranchList,
  CommitResult,
  GitAutofetchError,
  GitAutofetchIntervalMin,
  GitCommitOptions,
  GitContinueOpResult,
  GitExpandedGroupKey,
  GitExpandedGroups,
  GitExpandedTreeNodes,
  GitFastForwardResult,
  GitFetchAllResult,
  GitHistoryScope,
  GitMarkResolvedResult,
  GitMergeMode,
  GitMergeResult,
  GitPanelSegment,
  GitPanelStateUpdate,
  GitRebaseResult,
  GitStatus,
  GitSyncError,
  GitSyncResult,
  LogEntry,
  PullResult,
  PushResult,
  RemoteTag,
  RepoInfo,
  StashEntry,
  Tag,
  ViewMode,
};

export type GitOperationKind =
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "fetch"
  | "pull"
  | "push"
  | "pushTags"
  | "stash"
  | "stashPop"
  | "stashApply"
  | "stashDrop"
  | "stashGroup"
  | "checkout"
  | "checkoutDetached"
  | "checkoutTracking"
  | "createBranch"
  | "deleteBranch"
  | "deleteRemoteBranch"
  | "renameBranch"
  | "setUpstream"
  | "fastForwardBranch"
  | "addRemote"
  | "removeRemote"
  | "createTag"
  | "deleteTag"
  | "deleteRemoteTag"
  | "refresh"
  | "init"
  | "sync"
  | "undoLastCommit"
  | "resetSoft"
  | "merge"
  | "rebase"
  | "cherryPick"
  | "abortOp"
  | "continueOp"
  | "markResolved";

export interface GitInFlightOp {
  kind: GitOperationKind;
  startedAt: number;
}

export interface GitStoreError {
  kind: string;
  message: string;
  details?: string;
  operation?: GitOperationKind;
  hint?: GitActionHint;
}

export interface GitPushOptions {
  force?: boolean;
  publish?: boolean;
}

export interface PendingNonFFRetry {
  branch: string;
  attemptedAt: number;
  originalPushOpts: GitPushOptions;
}

export interface GitSession {
  repoInfo: RepoInfo;
  status: GitStatus | null;
  statusFetching: boolean;
  branchInfo: BranchInfo | null;
  expandedGroups: GitExpandedGroups;
  expandedTreeNodes: GitExpandedTreeNodes;
  commitOptions: GitCommitOptions;
  autofetchIntervalMin: GitAutofetchIntervalMin;
  autofetchManualPaused: boolean;
  autofetchFetching: boolean;
  autofetchConsecutiveFailures: number;
  autofetchLastError: GitAutofetchError | null;
  autofetchPausedBannerVisible: boolean;
  panelSegment: GitPanelSegment;
  historyRef: string;
  historyScope: GitHistoryScope;
  inFlightOp: GitInFlightOp | null;
  lastError: GitStoreError | null;
  pendingNonFFRetry: PendingNonFFRetry | null;
}

export interface CommitOptions {
  message?: string;
  amend?: boolean;
  sign?: boolean;
  signoff?: boolean;
  noVerify?: boolean;
}

export interface CreateBranchOptions {
  checkout?: boolean;
  fromRef?: string;
}
