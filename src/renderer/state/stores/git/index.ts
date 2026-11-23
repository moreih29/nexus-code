import { create } from "zustand";
import type {
  BranchList,
  CommitResult,
  GitAutofetchIntervalMin,
  GitCommitOptions,
  GitContinueOpResult,
  GitExpandedGroupKey,
  GitFastForwardResult,
  GitFetchAllResult,
  GitHistoryScope,
  GitMarkResolvedResult,
  GitMergeMode,
  GitMergeResult,
  GitPanelSegment,
  GitRebaseResult,
  GitSyncResult,
  LogEntry,
  PullResult,
  PushResult,
  RemoteTag,
  RepoInfo,
  StashEntry,
  Tag,
} from "../../../../shared/git/types";
import { registerWorkspaceCleanup } from "../../workspace-cleanup";
import { installCommitDraftFlushListeners } from "./draft-persistence";
import { installGitEventSubscriptions } from "./event-subscriptions";
import { createOperationsSlice, type OperationsSlice } from "./operations";
import { createPanelUiSlice } from "./panel-ui";
import { createQueriesSlice } from "./queries";
import { createSessionLifecycleSlice } from "./session-lifecycle";
import { createGitStoreContext } from "./store-context";
import type {
  CommitOptions,
  CreateBranchOptions,
  GitInFlightOp,
  GitOperationKind,
  GitPushOptions,
  GitSession,
  GitStoreError,
  PendingNonFFRetry,
} from "./types";

export type {
  CommitOptions,
  CreateBranchOptions,
  GitInFlightOp,
  GitOperationKind,
  GitPushOptions,
  GitSession,
  GitStoreError,
  PendingNonFFRetry,
};

interface GitState {
  sessions: Map<string, GitSession>;
  loadInitial: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  init: (workspaceId: string) => Promise<RepoInfo | undefined>;
  stage: (workspaceId: string, relPaths: string[]) => Promise<void>;
  unstage: (workspaceId: string, relPaths: string[]) => Promise<void>;
  stageContent: OperationsSlice["stageContent"];
  discard: (workspaceId: string, relPaths: string[], source?: GitExpandedGroupKey) => Promise<void>;
  commit: (workspaceId: string, options?: CommitOptions) => Promise<CommitResult | undefined>;
  commitAmend: (
    workspaceId: string,
    options?: Omit<CommitOptions, "amend">,
  ) => Promise<CommitResult | undefined>;
  commitEmpty: (workspaceId: string, message: string) => Promise<CommitResult | undefined>;
  undoLastCommit: (workspaceId: string) => Promise<void>;
  fetch: (workspaceId: string, remote?: string) => Promise<void>;
  fetchAll: (workspaceId: string) => Promise<GitFetchAllResult | undefined>;
  pull: (workspaceId: string) => Promise<PullResult | undefined>;
  push: (workspaceId: string, options?: GitPushOptions) => Promise<PushResult | undefined>;
  pushTags: (workspaceId: string, remote?: string) => Promise<void>;
  sync: (workspaceId: string) => Promise<GitSyncResult | undefined>;
  stash: (workspaceId: string, message?: string) => Promise<void>;
  stashPop: (workspaceId: string) => Promise<void>;
  listStashes: (workspaceId: string, signal?: AbortSignal) => Promise<StashEntry[] | undefined>;
  stashApply: (workspaceId: string, index: number) => Promise<boolean>;
  stashDrop: (workspaceId: string, index: number) => Promise<boolean>;
  stashGroup: (workspaceId: string, paths: string[], message?: string) => Promise<boolean>;
  checkout: (workspaceId: string, ref: string) => Promise<void>;
  checkoutDetached: (workspaceId: string, sha: string) => Promise<void>;
  checkoutTracking: (workspaceId: string, remoteRef: string) => Promise<void>;
  merge: (
    workspaceId: string,
    branch: string,
    mode?: GitMergeMode,
  ) => Promise<GitMergeResult | undefined>;
  rebase: (workspaceId: string, onto: string) => Promise<GitRebaseResult | undefined>;
  cherryPick: (workspaceId: string, sha: string) => Promise<boolean>;
  abortOp: (workspaceId: string) => Promise<void>;
  continueOp: (workspaceId: string) => Promise<GitContinueOpResult | undefined>;
  markResolved: (
    workspaceId: string,
    paths: string[],
  ) => Promise<GitMarkResolvedResult | undefined>;
  resetSoft: (workspaceId: string, targetSha: string) => Promise<boolean>;
  createBranch: (
    workspaceId: string,
    name: string,
    checkoutOrOptions?: boolean | CreateBranchOptions,
  ) => Promise<void>;
  deleteBranch: (workspaceId: string, name: string, force?: boolean) => Promise<void>;
  deleteRemoteBranch: (workspaceId: string, remote: string, name: string) => Promise<void>;
  renameBranch: (workspaceId: string, from: string, to: string) => Promise<void>;
  setUpstream: (workspaceId: string, branch: string, upstream: string | null) => Promise<void>;
  fastForwardBranch: (
    workspaceId: string,
    branch: string,
    remote: string,
    remoteRef: string,
  ) => Promise<GitFastForwardResult | undefined>;
  addRemote: (workspaceId: string, name: string, url: string) => Promise<boolean>;
  removeRemote: (workspaceId: string, name: string) => Promise<boolean>;
  listBranches: (workspaceId: string, signal?: AbortSignal) => Promise<BranchList | undefined>;
  listTags: (workspaceId: string, signal?: AbortSignal) => Promise<Tag[] | undefined>;
  listRemoteTags: (
    workspaceId: string,
    remote: string,
    signal?: AbortSignal,
  ) => Promise<RemoteTag[] | undefined>;
  createTag: (
    workspaceId: string,
    name: string,
    options?: { ref?: string; message?: string },
  ) => Promise<boolean>;
  deleteTag: (workspaceId: string, name: string) => Promise<boolean>;
  deleteRemoteTag: (workspaceId: string, remote: string, name: string) => Promise<boolean>;
  listRecentCommits: (
    workspaceId: string,
    signal?: AbortSignal,
    ref?: string,
  ) => Promise<LogEntry[] | undefined>;
  setCommitDraft: (workspaceId: string, text: string) => void;
  flushCommitDraft: (workspaceId: string) => void;
  flushAllCommitDrafts: () => void;
  setCommitOption: <K extends keyof GitCommitOptions>(
    workspaceId: string,
    option: K,
    value: GitCommitOptions[K],
  ) => void;
  setAutofetchInterval: (
    workspaceId: string,
    intervalMin: GitAutofetchIntervalMin,
  ) => Promise<void>;
  pauseAutofetch: (workspaceId: string) => Promise<void>;
  resumeAutofetch: (workspaceId: string) => Promise<void>;
  setPanelSegment: (workspaceId: string, segment: GitPanelSegment) => void;
  setHistoryRef: (workspaceId: string, ref: string) => void;
  setHistoryScope: (workspaceId: string, scope: GitHistoryScope) => void;
  setExpandedGroup: (workspaceId: string, group: GitExpandedGroupKey, expanded: boolean) => void;
  clearPendingNonFFRetry: (workspaceId: string) => void;
  toggleExpandedTreeNode: (
    workspaceId: string,
    groupKey: GitExpandedGroupKey,
    relPath: string,
  ) => void;
  expandAllTrees: (workspaceId: string) => void;
  collapseAllTrees: (workspaceId: string) => void;
  closeAllForWorkspace: (workspaceId: string) => void;
}

export const useGitStore = create<GitState>((set, get) => {
  registerWorkspaceCleanup((id) => {
    get().closeAllForWorkspace(id);
  });

  // biome-ignore lint/suspicious/noExplicitAny: zustand set/get are typed by the create<GitState> wrapper
  const ctx = createGitStoreContext(set as (updater: (state: any) => any) => void, get);

  return {
    sessions: new Map(),
    ...createSessionLifecycleSlice(ctx),
    ...createOperationsSlice(ctx),
    ...createQueriesSlice(ctx),
    ...createPanelUiSlice(ctx),
  };
});

installGitEventSubscriptions();
installCommitDraftFlushListeners();

export function useGitSession(workspaceId: string): GitSession | undefined {
  return useGitStore((s) => s.sessions.get(workspaceId));
}
