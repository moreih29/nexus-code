import { create } from "zustand";
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
} from "../../../shared/types/git";
import { DEFAULT_GIT_PANEL_STATE } from "../../../shared/types/git";
import type { ViewMode } from "../../../shared/types/panel";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL } from "../../../shared/types/panel";
import { ipcCall, ipcListen, ipcStream } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../lifecycle/workspace-cleanup";
import {
  cancelCommitDraftSave,
  cancelStatusHintRefresh,
  flushAllCommitDraftSaves,
  flushCommitDraftSave,
  installCommitDraftFlushListeners,
  scheduleCommitDraftSave,
} from "./git-draft-persistence";
import { installGitEventSubscriptions } from "./git-event-subscriptions";
import { persistPanelState, persistViewOptions } from "./git-panel-state-io";
import {
  collectRecentCommits,
  createDefaultSession,
  isStatusFetchingOperation,
  resolveCommitOptions,
} from "./git-session-defaults";
import {
  firstRejectedReason,
  gitStoreErrorFromUnknown,
  isAbortError,
  isPendingNonFFError,
  normalizePushOptions,
  pendingRetryFromPushError,
} from "./git-store-helpers";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  /**
   * Actionable next-step payload populated from `GitError.hint` when the
   * main process emits a typed preflight failure. The Source Control panel
   * uses this to render one-click recovery affordances (Publish branch,
   * Track remote, Make initial commit) instead of a raw error toast.
   */
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
  commitDraft: string;
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
  viewMode: ViewMode;
  compactFolders: boolean;
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

interface GitState {
  sessions: Map<string, GitSession>;
  loadInitial: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  init: (workspaceId: string) => Promise<RepoInfo | undefined>;
  stage: (workspaceId: string, relPaths: string[]) => Promise<void>;
  unstage: (workspaceId: string, relPaths: string[]) => Promise<void>;
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
  setViewMode: (workspaceId: string, viewMode: ViewMode) => void;
  setCompactFolders: (workspaceId: string, compactFolders: boolean) => void;
  clearPendingNonFFRetry: (workspaceId: string) => void;
  toggleExpandedTreeNode: (
    workspaceId: string,
    groupKey: GitExpandedGroupKey,
    relPath: string,
  ) => void;
  closeAllForWorkspace: (workspaceId: string) => void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const controllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useGitStore = create<GitState>((set, get) => {
  registerWorkspaceCleanup((id) => {
    get().closeAllForWorkspace(id);
  });

  /**
   * Update an existing session only. IPC broadcasts use this path so an
   * event for a workspace without an active session is dropped silently.
   */
  function updateExistingSession(
    workspaceId: string,
    updater: (session: GitSession) => GitSession,
  ): void {
    set((state) => {
      const session = state.sessions.get(workspaceId);
      if (!session) return state;

      const next = new Map(state.sessions);
      next.set(workspaceId, updater(session));
      return { sessions: next };
    });
  }

  /**
   * Update a session, creating a default one first when a user action
   * arrives before the panel has been seeded.
   */
  function upsertSession(workspaceId: string, updater: (session: GitSession) => GitSession): void {
    set((state) => {
      const session = state.sessions.get(workspaceId) ?? createDefaultSession();
      const next = new Map(state.sessions);
      next.set(workspaceId, updater(session));
      return { sessions: next };
    });
  }

  /**
   * Mark a workspace operation as running and replace any previous op
   * controller so cleanup can abort the current unit of work.
   */
  function beginOperation(workspaceId: string, kind: GitOperationKind): AbortController {
    const prior = controllers.get(workspaceId);
    if (prior) {
      prior.abort();
      controllers.delete(workspaceId);
    }

    const ctrl = new AbortController();
    controllers.set(workspaceId, ctrl);

    upsertSession(workspaceId, (session) => {
      const priorWasStatusFetch =
        session.inFlightOp?.kind === "refresh" || session.inFlightOp?.kind === "init";
      const preservePendingRetry = kind === "pull" || kind === "push";
      return {
        ...session,
        statusFetching: isStatusFetchingOperation(kind)
          ? true
          : priorWasStatusFetch
            ? false
            : session.statusFetching,
        inFlightOp: { kind, startedAt: Date.now() },
        lastError: null,
        pendingNonFFRetry: preservePendingRetry ? session.pendingNonFFRetry : null,
      };
    });

    return ctrl;
  }

  /**
   * Finish the current operation only when it still owns the workspace's
   * controller; stale promises from aborted operations are ignored.
   */
  function finishOperation(
    workspaceId: string,
    kind: GitOperationKind,
    ctrl: AbortController,
  ): void {
    if (controllers.get(workspaceId) !== ctrl) return;

    controllers.delete(workspaceId);
    updateExistingSession(workspaceId, (session) => ({
      ...session,
      statusFetching: isStatusFetchingOperation(kind) ? false : session.statusFetching,
      inFlightOp: null,
    }));
  }

  /**
   * Record an operation error on the matching session unless the operation
   * was superseded or intentionally aborted.
   */
  function failOperation(
    workspaceId: string,
    kind: GitOperationKind,
    ctrl: AbortController,
    error: unknown,
  ): void {
    if (controllers.get(workspaceId) !== ctrl || isAbortError(error)) return;

    updateExistingSession(workspaceId, (session) => ({
      ...session,
      statusFetching: isStatusFetchingOperation(kind) ? false : session.statusFetching,
      lastError: gitStoreErrorFromUnknown(error, kind),
    }));
  }

  /**
   * Preserve the normal inline error banner for operations that intentionally
   * return a typed failure envelope instead of rejecting the IPC call.
   */
  function recordEnvelopeError(
    workspaceId: string,
    kind: GitOperationKind,
    error: GitSyncError,
  ): void {
    updateExistingSession(workspaceId, (session) => ({
      ...session,
      lastError: {
        kind: error.kind,
        message: error.message,
        details: error.details,
        operation: kind,
      },
    }));
  }

  /**
   * Shared operation wrapper: set `inFlightOp`, run the typed IPC call,
   * normalize errors into state, then clear the operation on completion.
   */
  async function runOperation<T>(
    workspaceId: string,
    kind: GitOperationKind,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const ctrl = beginOperation(workspaceId, kind);
    try {
      return await run(ctrl.signal);
    } catch (error) {
      failOperation(workspaceId, kind, ctrl, error);
      return undefined;
    } finally {
      finishOperation(workspaceId, kind, ctrl);
    }
  }

  /**
   * Shared operation wrapper for branch flows whose caller needs to branch on
   * the typed error (for example unmerged delete → force-delete confirmation).
   * State still records the error before it is rethrown to the dialog owner.
   */
  async function runOperationStrict<T>(
    workspaceId: string,
    kind: GitOperationKind,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ctrl = beginOperation(workspaceId, kind);
    try {
      return await run(ctrl.signal);
    } catch (error) {
      failOperation(workspaceId, kind, ctrl, error);
      throw error;
    } finally {
      finishOperation(workspaceId, kind, ctrl);
    }
  }

  /**
   * Persist the commit draft immediately after successful commit so a
   * pending debounce cannot later restore the pre-commit draft.
   */
  function clearCommitDraftAfterCommit(workspaceId: string): void {
    cancelCommitDraftSave(workspaceId);
    updateExistingSession(workspaceId, (session) => ({ ...session, commitDraft: "" }));
    persistPanelState(workspaceId, { commitDraft: "" });
  }

  return {
    sessions: new Map(),

    async loadInitial(workspaceId) {
      if (get().sessions.has(workspaceId)) return;

      set((state) => {
        if (state.sessions.has(workspaceId)) return state;
        const next = new Map(state.sessions);
        next.set(workspaceId, createDefaultSession({ statusFetching: true }));
        return { sessions: next };
      });

      const [repoInfoResult, statusResult, panelStateResult, viewOptionsResult] =
        await Promise.allSettled([
          ipcCall("git", "getRepoInfo", { workspaceId }),
          ipcCall("git", "getStatus", { workspaceId }),
          ipcCall("git", "getPanelState", { workspaceId }),
          ipcCall("panel", "getViewOptions", { workspaceId, panelKind: "git" }),
        ]);

      updateExistingSession(workspaceId, (session) => {
        const firstError = firstRejectedReason(
          repoInfoResult,
          statusResult,
          panelStateResult,
          viewOptionsResult,
        );
        return {
          ...session,
          repoInfo: repoInfoResult.status === "fulfilled" ? repoInfoResult.value : session.repoInfo,
          status: statusResult.status === "fulfilled" ? statusResult.value : session.status,
          statusFetching: false,
          branchInfo:
            statusResult.status === "fulfilled" ? statusResult.value.branch : session.branchInfo,
          commitDraft:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.commitDraft
              : session.commitDraft,
          expandedGroups:
            panelStateResult.status === "fulfilled"
              ? { ...panelStateResult.value.expandedGroups }
              : session.expandedGroups,
          expandedTreeNodes:
            panelStateResult.status === "fulfilled"
              ? { ...panelStateResult.value.expandedTreeNodes }
              : session.expandedTreeNodes,
          commitOptions:
            panelStateResult.status === "fulfilled"
              ? { ...panelStateResult.value.commitOptions }
              : session.commitOptions,
          autofetchIntervalMin:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.autofetchIntervalMin
              : session.autofetchIntervalMin,
          autofetchManualPaused:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.autofetchManualPaused
              : session.autofetchManualPaused,
          panelSegment:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.panelSegment
              : session.panelSegment,
          historyRef:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.historyRef
              : session.historyRef,
          historyScope:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.historyScope
              : session.historyScope,
          viewMode:
            viewOptionsResult.status === "fulfilled"
              ? viewOptionsResult.value.viewMode
              : session.viewMode,
          compactFolders:
            viewOptionsResult.status === "fulfilled"
              ? viewOptionsResult.value.compactFolders
              : session.compactFolders,
          lastError: firstError ? gitStoreErrorFromUnknown(firstError) : null,
        };
      });
    },

    async refresh(workspaceId) {
      await runOperation(workspaceId, "refresh", async (signal) => {
        const repoInfo = await ipcCall("git", "refreshDetection", { workspaceId }, { signal });
        const status = await ipcCall("git", "getStatus", { workspaceId }, { signal });
        updateExistingSession(workspaceId, (session) => ({
          ...session,
          repoInfo,
          status,
          statusFetching: false,
          branchInfo: status.branch,
          lastError: null,
        }));
      });
    },

    async init(workspaceId) {
      return runOperation(workspaceId, "init", async (signal) => {
        const repoInfo = await ipcCall("git", "init", { workspaceId }, { signal });
        const status = await ipcCall("git", "getStatus", { workspaceId }, { signal });
        updateExistingSession(workspaceId, (session) => ({
          ...session,
          repoInfo,
          status,
          statusFetching: false,
          branchInfo: status.branch,
          lastError: null,
        }));
        return repoInfo;
      });
    },

    async stage(workspaceId, relPaths) {
      if (relPaths.length === 0) return;
      await runOperation(workspaceId, "stage", (signal) =>
        ipcCall("git", "stage", { workspaceId, relPaths }, { signal }),
      );
    },

    async unstage(workspaceId, relPaths) {
      if (relPaths.length === 0) return;
      await runOperation(workspaceId, "unstage", (signal) =>
        ipcCall("git", "unstage", { workspaceId, relPaths }, { signal }),
      );
    },

    async discard(workspaceId, relPaths, source) {
      if (relPaths.length === 0) return;
      await runOperation(workspaceId, "discard", (signal) =>
        ipcCall("git", "discardChanges", { workspaceId, relPaths, source }, { signal }),
      );
    },

    async commit(workspaceId, options = {}) {
      const message = options.message ?? get().sessions.get(workspaceId)?.commitDraft ?? "";
      const commitOptions = resolveCommitOptions(workspaceId, options, get().sessions);
      const result = await runOperation(workspaceId, "commit", (signal) =>
        ipcCall(
          "git",
          "commit",
          {
            workspaceId,
            message,
            amend: options.amend,
            sign: commitOptions.sign,
            signoff: commitOptions.signoff,
            noVerify: commitOptions.noVerify,
          },
          { signal },
        ),
      );

      if (result) {
        clearCommitDraftAfterCommit(workspaceId);
      }

      return result;
    },

    async commitAmend(workspaceId, options = {}) {
      const message = options.message ?? get().sessions.get(workspaceId)?.commitDraft ?? "";
      const commitOptions = resolveCommitOptions(workspaceId, options, get().sessions);
      const inlineMessage = message.trim().length > 0 ? message : undefined;
      const result = await runOperation(workspaceId, "commit", (signal) =>
        ipcCall(
          "git",
          "commitAmend",
          {
            workspaceId,
            message: inlineMessage,
            sign: commitOptions.sign,
            signoff: commitOptions.signoff,
            noVerify: commitOptions.noVerify,
          },
          { signal },
        ),
      );

      if (result) {
        clearCommitDraftAfterCommit(workspaceId);
      }

      return result;
    },

    async commitEmpty(workspaceId, message) {
      const commitOptions = resolveCommitOptions(workspaceId, {}, get().sessions);
      const result = await runOperation(workspaceId, "commit", (signal) =>
        ipcCall(
          "git",
          "commitEmpty",
          {
            workspaceId,
            message,
            sign: commitOptions.sign,
            signoff: commitOptions.signoff,
            noVerify: commitOptions.noVerify,
          },
          { signal },
        ),
      );

      if (result) {
        clearCommitDraftAfterCommit(workspaceId);
      }

      return result;
    },

    async undoLastCommit(workspaceId) {
      await runOperation(workspaceId, "undoLastCommit", (signal) =>
        ipcCall("git", "undoLastCommit", { workspaceId }, { signal }),
      );
    },

    async fetch(workspaceId, remote) {
      await runOperation(workspaceId, "fetch", (signal) =>
        ipcCall("git", "fetch", { workspaceId, remote }, { signal }),
      );
    },

    async fetchAll(workspaceId) {
      return runOperation(workspaceId, "fetch", (signal) =>
        ipcCall("git", "fetchAll", { workspaceId }, { signal }),
      );
    },

    async pull(workspaceId) {
      return runOperation(workspaceId, "pull", (signal) =>
        ipcCall("git", "pull", { workspaceId }, { signal }),
      );
    },

    async push(workspaceId, options = {}) {
      const originalPushOpts = normalizePushOptions(options);
      const ctrl = beginOperation(workspaceId, "push");
      try {
        const result = await ipcCall(
          "git",
          "push",
          { workspaceId, force: originalPushOpts.force, publish: originalPushOpts.publish },
          { signal: ctrl.signal },
        );
        updateExistingSession(workspaceId, (session) => ({
          ...session,
          pendingNonFFRetry: null,
        }));
        return result;
      } catch (error) {
        if (controllers.get(workspaceId) === ctrl && !isAbortError(error)) {
          const lastError = gitStoreErrorFromUnknown(error, "push");
          updateExistingSession(workspaceId, (session) => ({
            ...session,
            lastError,
            pendingNonFFRetry: pendingRetryFromPushError(session, lastError, originalPushOpts),
          }));
        }
        return undefined;
      } finally {
        finishOperation(workspaceId, "push", ctrl);
      }
    },

    async pushTags(workspaceId, remote) {
      await runOperation(workspaceId, "pushTags", (signal) =>
        ipcCall("git", "pushTags", { workspaceId, remote }, { signal }),
      );
    },

    async sync(workspaceId) {
      const result = await runOperation(workspaceId, "sync", (signal) =>
        ipcCall("git", "sync", { workspaceId }, { signal }),
      );
      if (result?.pulled === "error" && result.pullError) {
        recordEnvelopeError(workspaceId, "sync", result.pullError);
      }
      return result;
    },

    async stash(workspaceId, message) {
      await runOperation(workspaceId, "stash", (signal) =>
        ipcCall("git", "stash", { workspaceId, message }, { signal }),
      );
    },

    async stashPop(workspaceId) {
      await runOperation(workspaceId, "stashPop", (signal) =>
        ipcCall("git", "stashPop", { workspaceId }, { signal }),
      );
    },

    async listStashes(workspaceId, signal) {
      try {
        return await ipcCall("git", "stashList", { workspaceId }, signal ? { signal } : {});
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async stashApply(workspaceId, index) {
      const result = await runOperation(workspaceId, "stashApply", async (signal) => {
        await ipcCall("git", "stashApply", { workspaceId, index }, { signal });
        return true;
      });
      return result === true;
    },

    async stashDrop(workspaceId, index) {
      const result = await runOperation(workspaceId, "stashDrop", async (signal) => {
        await ipcCall("git", "stashDrop", { workspaceId, index }, { signal });
        return true;
      });
      return result === true;
    },

    async stashGroup(workspaceId, paths, message) {
      if (paths.length === 0) return false;
      const result = await runOperation(workspaceId, "stashGroup", async (signal) => {
        await ipcCall("git", "stashGroup", { workspaceId, paths, message }, { signal });
        return true;
      });
      return result === true;
    },

    async checkout(workspaceId, ref) {
      await runOperation(workspaceId, "checkout", (signal) =>
        ipcCall("git", "checkout", { workspaceId, ref }, { signal }),
      );
    },

    async checkoutDetached(workspaceId, sha) {
      await runOperation(workspaceId, "checkoutDetached", (signal) =>
        ipcCall("git", "checkoutDetached", { workspaceId, sha }, { signal }),
      );
    },

    async checkoutTracking(workspaceId, remoteRef) {
      await runOperation(workspaceId, "checkoutTracking", (signal) =>
        ipcCall("git", "checkoutTracking", { workspaceId, remoteRef }, { signal }),
      );
    },

    async merge(workspaceId, branch, mode = "default") {
      return runOperation(workspaceId, "merge", (signal) =>
        ipcCall("git", "merge", { workspaceId, branch, mode }, { signal }),
      );
    },

    async rebase(workspaceId, onto) {
      return runOperation(workspaceId, "rebase", (signal) =>
        ipcCall("git", "rebase", { workspaceId, onto }, { signal }),
      );
    },

    async cherryPick(workspaceId, sha) {
      const result = await runOperation(workspaceId, "cherryPick", async (signal) => {
        await ipcCall("git", "cherryPick", { workspaceId, sha }, { signal });
        return true;
      });
      return result === true;
    },

    async abortOp(workspaceId) {
      await runOperation(workspaceId, "abortOp", (signal) =>
        ipcCall("git", "abortOp", { workspaceId }, { signal }),
      );
    },

    async continueOp(workspaceId) {
      return runOperation(workspaceId, "continueOp", (signal) =>
        ipcCall("git", "continueOp", { workspaceId }, { signal }),
      );
    },

    async markResolved(workspaceId, paths) {
      if (paths.length === 0) return undefined;
      return runOperation(workspaceId, "markResolved", (signal) =>
        ipcCall("git", "markResolved", { workspaceId, paths }, { signal }),
      );
    },

    async resetSoft(workspaceId, targetSha) {
      const result = await runOperation(workspaceId, "resetSoft", async (signal) => {
        await ipcCall("git", "resetSoft", { workspaceId, targetSha }, { signal });
        return true;
      });
      return result === true;
    },

    async createBranch(workspaceId, name, checkoutOrOptions) {
      const options =
        typeof checkoutOrOptions === "boolean"
          ? { checkout: checkoutOrOptions }
          : (checkoutOrOptions ?? {});
      await runOperation(workspaceId, "createBranch", (signal) =>
        ipcCall(
          "git",
          "createBranch",
          { workspaceId, name, checkout: options.checkout, fromRef: options.fromRef },
          { signal },
        ),
      );
    },

    async deleteBranch(workspaceId, name, force) {
      await runOperationStrict(workspaceId, "deleteBranch", (signal) =>
        ipcCall("git", "deleteBranch", { workspaceId, name, force }, { signal }),
      );
    },

    async deleteRemoteBranch(workspaceId, remote, name) {
      await runOperationStrict(workspaceId, "deleteRemoteBranch", (signal) =>
        ipcCall("git", "deleteRemoteBranch", { workspaceId, remote, name }, { signal }),
      );
    },

    async renameBranch(workspaceId, from, to) {
      await runOperationStrict(workspaceId, "renameBranch", (signal) =>
        ipcCall("git", "renameBranch", { workspaceId, from, to }, { signal }),
      );
    },

    async setUpstream(workspaceId, branch, upstream) {
      await runOperationStrict(workspaceId, "setUpstream", (signal) =>
        ipcCall("git", "setUpstream", { workspaceId, branch, upstream }, { signal }),
      );
    },

    async fastForwardBranch(workspaceId, branch, remote, remoteRef) {
      return runOperation(workspaceId, "fastForwardBranch", (signal) =>
        ipcCall("git", "fastForwardBranch", { workspaceId, branch, remote, remoteRef }, { signal }),
      );
    },

    async addRemote(workspaceId, name, url) {
      const result = await runOperation(workspaceId, "addRemote", async (signal) => {
        await ipcCall("git", "addRemote", { workspaceId, name, url }, { signal });
        return true;
      });
      return result === true;
    },

    async removeRemote(workspaceId, name) {
      const result = await runOperation(workspaceId, "removeRemote", async (signal) => {
        await ipcCall("git", "removeRemote", { workspaceId, name }, { signal });
        return true;
      });
      return result === true;
    },

    async listBranches(workspaceId, signal) {
      try {
        return await ipcCall("git", "listBranches", { workspaceId }, signal ? { signal } : {});
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async listTags(workspaceId, signal) {
      try {
        return await ipcCall("git", "listTags", { workspaceId }, signal ? { signal } : {});
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async listRemoteTags(workspaceId, remote, signal) {
      try {
        return await ipcCall(
          "git",
          "listRemoteTags",
          { workspaceId, remote },
          signal ? { signal } : {},
        );
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    async createTag(workspaceId, name, options = {}) {
      const result = await runOperation(workspaceId, "createTag", async (signal) => {
        await ipcCall(
          "git",
          "createTag",
          { workspaceId, name, ref: options.ref, message: options.message },
          { signal },
        );
        return true;
      });
      return result === true;
    },

    async deleteTag(workspaceId, name) {
      const result = await runOperation(workspaceId, "deleteTag", async (signal) => {
        await ipcCall("git", "deleteTag", { workspaceId, name }, { signal });
        return true;
      });
      return result === true;
    },

    async deleteRemoteTag(workspaceId, remote, name) {
      const result = await runOperation(workspaceId, "deleteRemoteTag", async (signal) => {
        await ipcCall("git", "deleteRemoteTag", { workspaceId, remote, name }, { signal });
        return true;
      });
      return result === true;
    },

    async listRecentCommits(workspaceId, signal, ref) {
      try {
        return await collectRecentCommits(workspaceId, signal, ref);
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    setCommitDraft(workspaceId, text) {
      upsertSession(workspaceId, (session) => ({ ...session, commitDraft: text }));
      scheduleCommitDraftSave(workspaceId, text);
    },

    flushCommitDraft(workspaceId) {
      flushCommitDraftSave(workspaceId);
    },

    flushAllCommitDrafts() {
      flushAllCommitDraftSaves();
    },

    setCommitOption(workspaceId, option, value) {
      const session = get().sessions.get(workspaceId) ?? createDefaultSession();
      const commitOptions = { ...session.commitOptions, [option]: value };
      upsertSession(workspaceId, (cur) => ({ ...cur, commitOptions }));
      persistPanelState(workspaceId, { commitOptions });
    },

    async setAutofetchInterval(workspaceId, autofetchIntervalMin) {
      upsertSession(workspaceId, (session) => ({
        ...session,
        autofetchIntervalMin,
        autofetchManualPaused: false,
        autofetchPausedBannerVisible: false,
        autofetchLastError: null,
        autofetchConsecutiveFailures: 0,
      }));
      try {
        await ipcCall("autofetch", "setSchedule", {
          workspaceId,
          intervalMin: autofetchIntervalMin,
        });
      } catch (error) {
        console.error("[git] autofetch setSchedule failed", error);
      }
    },

    async pauseAutofetch(workspaceId) {
      upsertSession(workspaceId, (session) => ({
        ...session,
        autofetchManualPaused: true,
      }));
      try {
        await ipcCall("autofetch", "pause", { workspaceId });
      } catch (error) {
        console.error("[git] autofetch pause failed", error);
      }
    },

    async resumeAutofetch(workspaceId) {
      upsertSession(workspaceId, (session) => ({
        ...session,
        autofetchManualPaused: false,
        autofetchPausedBannerVisible: false,
        autofetchLastError: null,
        autofetchConsecutiveFailures: 0,
      }));
      try {
        await ipcCall("autofetch", "resume", { workspaceId });
      } catch (error) {
        console.error("[git] autofetch resume failed", error);
      }
    },

    setPanelSegment(workspaceId, panelSegment) {
      upsertSession(workspaceId, (session) => ({ ...session, panelSegment }));
      persistPanelState(workspaceId, { panelSegment });
    },

    setHistoryRef(workspaceId, historyRef) {
      const ref = historyRef.trim() || DEFAULT_GIT_PANEL_STATE.historyRef;
      upsertSession(workspaceId, (session) => ({ ...session, historyRef: ref }));
      persistPanelState(workspaceId, { historyRef: ref });
    },

    setHistoryScope(workspaceId, historyScope) {
      upsertSession(workspaceId, (session) => ({ ...session, historyScope }));
      persistPanelState(workspaceId, { historyScope });
    },

    setExpandedGroup(workspaceId, group, expanded) {
      const session = get().sessions.get(workspaceId);
      if (!session) return;

      const expandedGroups = { ...session.expandedGroups, [group]: expanded };
      updateExistingSession(workspaceId, (cur) => ({ ...cur, expandedGroups }));
      persistPanelState(workspaceId, { expandedGroups });
    },

    setViewMode(workspaceId, viewMode) {
      updateExistingSession(workspaceId, (cur) => ({ ...cur, viewMode }));
      persistViewOptions(workspaceId, { viewMode });
    },

    setCompactFolders(workspaceId, compactFolders) {
      updateExistingSession(workspaceId, (cur) => ({ ...cur, compactFolders }));
      persistViewOptions(workspaceId, { compactFolders });
    },

    clearPendingNonFFRetry(workspaceId) {
      updateExistingSession(workspaceId, (cur) => ({
        ...cur,
        pendingNonFFRetry: null,
        lastError: isPendingNonFFError(cur.lastError) ? null : cur.lastError,
      }));
    },

    toggleExpandedTreeNode(workspaceId, groupKey, relPath) {
      const session = get().sessions.get(workspaceId);
      if (!session) return;

      const current = session.expandedTreeNodes[groupKey];
      const isExpanded = current.includes(relPath);
      const next = isExpanded ? current.filter((p) => p !== relPath) : [...current, relPath];
      const expandedTreeNodes = { ...session.expandedTreeNodes, [groupKey]: next };
      updateExistingSession(workspaceId, (cur) => ({ ...cur, expandedTreeNodes }));
      persistPanelState(workspaceId, { expandedTreeNodes });
    },

    closeAllForWorkspace(workspaceId) {
      const ctrl = controllers.get(workspaceId);
      if (ctrl) {
        ctrl.abort();
        controllers.delete(workspaceId);
      }
      cancelCommitDraftSave(workspaceId);
      cancelStatusHintRefresh(workspaceId);
      set((state) => {
        if (!state.sessions.has(workspaceId)) return state;
        const next = new Map(state.sessions);
        next.delete(workspaceId);
        return { sessions: next };
      });
    },
  };
});

installGitEventSubscriptions();
installCommitDraftFlushListeners();

// ---------------------------------------------------------------------------
// Selector helper
// ---------------------------------------------------------------------------

/**
 * Subscribes to a single workspace's git session slice. Returns `undefined`
 * before `loadInitial` has run for that workspace — callers should treat the
 * absence as "git not yet initialised" rather than "no git repo".
 */
export function useGitSession(workspaceId: string): GitSession | undefined {
  return useGitStore((s) => s.sessions.get(workspaceId));
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh session object. Nested objects are cloned so sessions never
 * share mutable panel state.
 */
