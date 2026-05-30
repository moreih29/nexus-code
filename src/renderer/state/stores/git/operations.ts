/**
 * git-operations.ts — slice creator.
 *
 * Slice: all runOperation/runOperationStrict-wrapped git domain actions
 * + operation lifecycle. This is the bulk of the store.
 *
 * The `push` action is special — it calls beginOperation/finishOperation
 * directly rather than going through runOperation because it needs to capture
 * the pendingNonFFRetry from the error before finishOperation clears the
 * in-flight state.
 */

import type {
  CommitResult,
  GitContinueOpResult,
  GitFastForwardResult,
  GitFetchAllResult,
  GitMarkResolvedResult,
  GitMergeMode,
  GitMergeResult,
  GitRebaseResult,
  GitSyncResult,
  PullResult,
  PushResult,
} from "../../../../shared/git/types";
import { createLogger } from "../../../../shared/log/renderer";
import { ipcCallResult, unwrapGitResult } from "../../../ipc/client";
import { cancelCommitDraftSave } from "./draft-persistence";
import { persistPanelState } from "./panel-state-io";
import { resolveCommitOptions } from "./session-defaults";
import type { GitStoreContext } from "./store-context";
import {
  gitStoreErrorFromUnknown,
  isAbortError,
  isPendingNonFFError,
  normalizePushOptions,
  pendingRetryFromPushError,
} from "./store-helpers";
import type { CommitOptions, CreateBranchOptions, GitPushOptions } from "./types";

const log = createLogger("git");

export interface OperationsSlice {
  stage: (workspaceId: string, relPaths: string[]) => Promise<void>;
  unstage: (workspaceId: string, relPaths: string[]) => Promise<void>;
  discard: (
    workspaceId: string,
    relPaths: string[],
    source?: import("../../../../shared/git/types").GitExpandedGroupKey,
  ) => Promise<void>;
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
  createTag: (
    workspaceId: string,
    name: string,
    options?: { ref?: string; message?: string },
  ) => Promise<boolean>;
  deleteTag: (workspaceId: string, name: string) => Promise<boolean>;
  deleteRemoteTag: (workspaceId: string, remote: string, name: string) => Promise<boolean>;
  setAutofetchInterval: (
    workspaceId: string,
    intervalMin: import("../../../../shared/git/types").GitAutofetchIntervalMin,
  ) => Promise<void>;
  pauseAutofetch: (workspaceId: string) => Promise<void>;
  resumeAutofetch: (workspaceId: string) => Promise<void>;
  clearPendingNonFFRetry: (workspaceId: string) => void;
}

export function createOperationsSlice(ctx: GitStoreContext): OperationsSlice {
  const {
    get,
    controllers,
    updateExistingSession,
    upsertSession,
    beginOperation,
    finishOperation,
    runOperation,
    runOperationStrict,
    recordEnvelopeError,
  } = ctx;

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
    async stage(workspaceId, relPaths) {
      if (relPaths.length === 0) return;
      await runOperation(workspaceId, "stage", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "stage", { workspaceId, relPaths }, { signal })),
      );
    },

    async unstage(workspaceId, relPaths) {
      if (relPaths.length === 0) return;
      await runOperation(workspaceId, "unstage", async (signal) =>
        unwrapGitResult(
          await ipcCallResult("git", "unstage", { workspaceId, relPaths }, { signal }),
        ),
      );
    },

    async discard(workspaceId, relPaths, source) {
      if (relPaths.length === 0) return;
      await runOperation(workspaceId, "discard", async (signal) =>
        unwrapGitResult(
          await ipcCallResult(
            "git",
            "discardChanges",
            { workspaceId, relPaths, source },
            { signal },
          ),
        ),
      );
    },

    async commit(workspaceId, options = {}) {
      const message = options.message ?? get().sessions.get(workspaceId)?.commitDraft ?? "";
      const commitOptions = resolveCommitOptions(workspaceId, options, get().sessions);
      const result = await runOperation(workspaceId, "commit", async (signal) =>
        unwrapGitResult(
          await ipcCallResult(
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
      const result = await runOperation(workspaceId, "commit", async (signal) =>
        unwrapGitResult(
          await ipcCallResult(
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
        ),
      );

      if (result) {
        clearCommitDraftAfterCommit(workspaceId);
      }

      return result;
    },

    async commitEmpty(workspaceId, message) {
      const commitOptions = resolveCommitOptions(workspaceId, {}, get().sessions);
      const result = await runOperation(workspaceId, "commit", async (signal) =>
        unwrapGitResult(
          await ipcCallResult(
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
        ),
      );

      if (result) {
        clearCommitDraftAfterCommit(workspaceId);
      }

      return result;
    },

    async undoLastCommit(workspaceId) {
      await runOperation(workspaceId, "undoLastCommit", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "undoLastCommit", { workspaceId }, { signal })),
      );
    },

    async fetch(workspaceId, remote) {
      await runOperation(workspaceId, "fetch", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "fetch", { workspaceId, remote }, { signal })),
      );
    },

    async fetchAll(workspaceId) {
      return runOperation(workspaceId, "fetch", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "fetchAll", { workspaceId }, { signal })),
      );
    },

    async pull(workspaceId) {
      return runOperation(workspaceId, "pull", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "pull", { workspaceId }, { signal })),
      );
    },

    async push(workspaceId, options = {}) {
      const originalPushOpts = normalizePushOptions(options);
      const ctrl = beginOperation(workspaceId, "push");
      try {
        const result = unwrapGitResult(
          await ipcCallResult(
            "git",
            "push",
            { workspaceId, force: originalPushOpts.force, publish: originalPushOpts.publish },
            { signal: ctrl.signal },
          ),
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
      await runOperation(workspaceId, "pushTags", async (signal) =>
        unwrapGitResult(
          await ipcCallResult("git", "pushTags", { workspaceId, remote }, { signal }),
        ),
      );
    },

    async sync(workspaceId) {
      const result = await runOperation(workspaceId, "sync", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "sync", { workspaceId }, { signal })),
      );
      if (result?.pulled === "error" && result.pullError) {
        recordEnvelopeError(workspaceId, "sync", result.pullError);
      }
      return result;
    },

    async stash(workspaceId, message) {
      await runOperation(workspaceId, "stash", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "stash", { workspaceId, message }, { signal })),
      );
    },

    async stashPop(workspaceId) {
      await runOperation(workspaceId, "stashPop", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "stashPop", { workspaceId }, { signal })),
      );
    },

    async stashApply(workspaceId, index) {
      const result = await runOperation(workspaceId, "stashApply", async (signal) => {
        unwrapGitResult(
          await ipcCallResult("git", "stashApply", { workspaceId, index }, { signal }),
        );
        return true;
      });
      return result === true;
    },

    async stashDrop(workspaceId, index) {
      const result = await runOperation(workspaceId, "stashDrop", async (signal) => {
        unwrapGitResult(
          await ipcCallResult("git", "stashDrop", { workspaceId, index }, { signal }),
        );
        return true;
      });
      return result === true;
    },

    async stashGroup(workspaceId, paths, message) {
      if (paths.length === 0) return false;
      const result = await runOperation(workspaceId, "stashGroup", async (signal) => {
        unwrapGitResult(
          await ipcCallResult("git", "stashGroup", { workspaceId, paths, message }, { signal }),
        );
        return true;
      });
      return result === true;
    },

    async checkout(workspaceId, ref) {
      await runOperation(workspaceId, "checkout", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "checkout", { workspaceId, ref }, { signal })),
      );
    },

    async checkoutDetached(workspaceId, sha) {
      await runOperation(workspaceId, "checkoutDetached", async (signal) =>
        unwrapGitResult(
          await ipcCallResult("git", "checkoutDetached", { workspaceId, sha }, { signal }),
        ),
      );
    },

    async checkoutTracking(workspaceId, remoteRef) {
      await runOperation(workspaceId, "checkoutTracking", async (signal) =>
        unwrapGitResult(
          await ipcCallResult("git", "checkoutTracking", { workspaceId, remoteRef }, { signal }),
        ),
      );
    },

    async merge(workspaceId, branch, mode = "default") {
      return runOperation(workspaceId, "merge", async (signal) =>
        unwrapGitResult(
          await ipcCallResult("git", "merge", { workspaceId, branch, mode }, { signal }),
        ),
      );
    },

    async rebase(workspaceId, onto) {
      return runOperation(workspaceId, "rebase", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "rebase", { workspaceId, onto }, { signal })),
      );
    },

    async cherryPick(workspaceId, sha) {
      const result = await runOperation(workspaceId, "cherryPick", async (signal) => {
        unwrapGitResult(await ipcCallResult("git", "cherryPick", { workspaceId, sha }, { signal }));
        return true;
      });
      return result === true;
    },

    async abortOp(workspaceId) {
      await runOperation(workspaceId, "abortOp", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "abortOp", { workspaceId }, { signal })),
      );
    },

    async continueOp(workspaceId) {
      return runOperation(workspaceId, "continueOp", async (signal) =>
        unwrapGitResult(await ipcCallResult("git", "continueOp", { workspaceId }, { signal })),
      );
    },

    async markResolved(workspaceId, paths) {
      if (paths.length === 0) return undefined;
      return runOperation(workspaceId, "markResolved", async (signal) =>
        unwrapGitResult(
          await ipcCallResult("git", "markResolved", { workspaceId, paths }, { signal }),
        ),
      );
    },

    async resetSoft(workspaceId, targetSha) {
      const result = await runOperation(workspaceId, "resetSoft", async (signal) => {
        unwrapGitResult(
          await ipcCallResult("git", "resetSoft", { workspaceId, targetSha }, { signal }),
        );
        return true;
      });
      return result === true;
    },

    async createBranch(workspaceId, name, checkoutOrOptions) {
      const options =
        typeof checkoutOrOptions === "boolean"
          ? { checkout: checkoutOrOptions }
          : (checkoutOrOptions ?? {});
      await runOperation(workspaceId, "createBranch", async (signal) =>
        unwrapGitResult(
          await ipcCallResult(
            "git",
            "createBranch",
            { workspaceId, name, checkout: options.checkout, fromRef: options.fromRef },
            { signal },
          ),
        ),
      );
    },

    async deleteBranch(workspaceId, name, force) {
      await runOperationStrict(workspaceId, "deleteBranch", async (signal) =>
        unwrapGitResult(
          await ipcCallResult("git", "deleteBranch", { workspaceId, name, force }, { signal }),
        ),
      );
    },

    async deleteRemoteBranch(workspaceId, remote, name) {
      await runOperationStrict(workspaceId, "deleteRemoteBranch", async (signal) =>
        unwrapGitResult(
          await ipcCallResult(
            "git",
            "deleteRemoteBranch",
            { workspaceId, remote, name },
            { signal },
          ),
        ),
      );
    },

    async renameBranch(workspaceId, from, to) {
      await runOperationStrict(workspaceId, "renameBranch", async (signal) =>
        unwrapGitResult(
          await ipcCallResult("git", "renameBranch", { workspaceId, from, to }, { signal }),
        ),
      );
    },

    async setUpstream(workspaceId, branch, upstream) {
      await runOperationStrict(workspaceId, "setUpstream", async (signal) =>
        unwrapGitResult(
          await ipcCallResult("git", "setUpstream", { workspaceId, branch, upstream }, { signal }),
        ),
      );
    },

    async fastForwardBranch(workspaceId, branch, remote, remoteRef) {
      return runOperation(workspaceId, "fastForwardBranch", async (signal) =>
        unwrapGitResult(
          await ipcCallResult(
            "git",
            "fastForwardBranch",
            { workspaceId, branch, remote, remoteRef },
            { signal },
          ),
        ),
      );
    },

    async addRemote(workspaceId, name, url) {
      const result = await runOperation(workspaceId, "addRemote", async (signal) => {
        unwrapGitResult(
          await ipcCallResult("git", "addRemote", { workspaceId, name, url }, { signal }),
        );
        return true;
      });
      return result === true;
    },

    async removeRemote(workspaceId, name) {
      const result = await runOperation(workspaceId, "removeRemote", async (signal) => {
        unwrapGitResult(
          await ipcCallResult("git", "removeRemote", { workspaceId, name }, { signal }),
        );
        return true;
      });
      return result === true;
    },

    async createTag(workspaceId, name, options = {}) {
      const result = await runOperation(workspaceId, "createTag", async (signal) => {
        unwrapGitResult(
          await ipcCallResult(
            "git",
            "createTag",
            { workspaceId, name, ref: options.ref, message: options.message },
            { signal },
          ),
        );
        return true;
      });
      return result === true;
    },

    async deleteTag(workspaceId, name) {
      const result = await runOperation(workspaceId, "deleteTag", async (signal) => {
        unwrapGitResult(await ipcCallResult("git", "deleteTag", { workspaceId, name }, { signal }));
        return true;
      });
      return result === true;
    },

    async deleteRemoteTag(workspaceId, remote, name) {
      const result = await runOperation(workspaceId, "deleteRemoteTag", async (signal) => {
        unwrapGitResult(
          await ipcCallResult("git", "deleteRemoteTag", { workspaceId, remote, name }, { signal }),
        );
        return true;
      });
      return result === true;
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
      const result = await ipcCallResult("autofetch", "setSchedule", {
        workspaceId,
        intervalMin: autofetchIntervalMin,
      });
      // Fire-and-forget: autofetch scheduling errors are non-critical; UI state
      // was already updated optimistically above.
      if (!result.ok) {
        log.error(`autofetch setSchedule failed: ${result.message}`);
      }
    },

    async pauseAutofetch(workspaceId) {
      upsertSession(workspaceId, (session) => ({
        ...session,
        autofetchManualPaused: true,
      }));
      const result = await ipcCallResult("autofetch", "pause", { workspaceId });
      // Fire-and-forget: autofetch pause errors are non-critical; UI state
      // was already updated optimistically above.
      if (!result.ok) {
        log.error(`autofetch pause failed: ${result.message}`);
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
      const result = await ipcCallResult("autofetch", "resume", { workspaceId });
      // Fire-and-forget: autofetch resume errors are non-critical; UI state
      // was already updated optimistically above.
      if (!result.ok) {
        log.error(`autofetch resume failed: ${result.message}`);
      }
    },

    clearPendingNonFFRetry(workspaceId) {
      updateExistingSession(workspaceId, (cur) => ({
        ...cur,
        pendingNonFFRetry: null,
        lastError: isPendingNonFFError(cur.lastError) ? null : cur.lastError,
      }));
    },
  };
}
