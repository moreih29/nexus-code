/**
 * useGitPanelActions — extracts the business-logic handlers that were
 * previously inline in git-panel.tsx.
 *
 * Owns: push-guard policy, merge-option seeding, primary-action dispatch,
 * commit/commit-and-push flows, discard/remove-remote prompts, sync,
 * stash-group prompt, tag-history retarget, branch-create dialog lifecycle,
 * branch/tag picker launchers.
 *
 * git-panel.tsx calls this hook and delegates rendering; all policy stays here.
 */

import { useCallback, useRef } from "react";
import type { BranchInfo, GitExpandedGroupKey, GitMergeMode, Tag } from "../../../../../shared/git/types";
import type { GitPushOptions } from "../../../../state/stores/git";
import { useGitStore } from "../../../../state/stores/git";
import { useShallow } from "zustand/shallow";
import type { BranchPickerMode } from "../branch/picker";
import { submitBranchCreate } from "../branch/create-dialog";
import { buildSquashCommitDraft } from "../pickers/merge-options-dialog";
import type { TagPickerMode } from "../pickers/tag-picker-source";
import { buildRemoteUpstreamWarning } from "../utils/more-menu-model";
import type { PushGuardActionKind } from "../utils/push-guard-banner";
import {
  buildPublishBranchPrompt,
  buildTagHistoryRevealMessage,
  tagHistoryRef,
} from "./panel-actions";
import type { GitDialogsState } from "./use-dialogs";
import type { GitPanelPickersState } from "../pickers/use-panel-pickers";

// ---------------------------------------------------------------------------
// Types surfaced to the panel
// ---------------------------------------------------------------------------

export interface GitPanelActionsInput {
  workspaceId: string;
  dialogs: GitDialogsState;
  pickers: GitPanelPickersState;
  /** Derived state the panel already computed */
  derived: {
    trimmedDraft: string;
    hasStagedChanges: boolean;
    stageablePaths: string[];
    allChangedPaths: string[];
    hasUpstream: boolean;
    hasRemote: boolean;
    capabilitiesHasHEAD: boolean;
    capabilitiesRemotes: readonly string[];
    currentBranchName: string | null;
    actionStateKind: string;
    pendingNonFFRetry: { originalPushOpts: GitPushOptions } | null | undefined;
    branchInfo: BranchInfo | null;
  };
}

export interface GitPanelActions {
  /** Opens the branch-create dialog and loads the branch list for validation. */
  openBranchCreateDialog: (fromRef?: string) => void;
  /** Closes the branch-create dialog and aborts any in-flight list load. */
  closeBranchCreateDialog: () => void;
  /** Opens the shared branch picker at a given mode. */
  openBranchPicker: (mode: BranchPickerMode) => void;
  /** Opens the shared tag picker at a given mode. */
  openTagPicker: (mode: TagPickerMode, remote?: string) => void;
  /** Executes a push, intercepting un-tracked branches for the publish prompt. */
  requestPush: (options?: GitPushOptions) => Promise<void>;
  /** Runs the selected merge mode (squash seeds the commit draft). */
  confirmMergeOption: (mode: GitMergeMode) => Promise<void>;
  /** Commits staged changes. */
  handleCommitStaged: () => Promise<void>;
  /** Stages all unstaged paths then commits. */
  handleCommitAll: () => Promise<void>;
  /** Amends the most-recent commit. */
  handleAmend: () => Promise<void>;
  /** Commits staged changes then pushes. */
  handleCommitAndPush: () => Promise<void>;
  /** Pulls then pushes (sync), shows a banner if pull was cancelled. */
  handleSync: () => Promise<void>;
  /** Opens the discard-confirmation dialog. */
  requestDiscard: (paths: string[], description: string, source?: string) => void;
  /** Opens the remove-remote confirmation dialog. */
  requestRemoveRemote: (remote: string) => void;
  /** Opens the stash-group prompt for a named group. */
  requestStashGroup: (paths: string[], label: string) => void;
  /** Retargets the History panel to the given tag and closes the tag picker. */
  revealTagInHistory: (tag: Tag) => void;
  /** Dispatches a typed push-guard banner action. */
  runPushGuardAction: (kind: PushGuardActionKind) => void;
  /** Dispatches the primary action chosen by the action-button selector. */
  runPrimaryAction: () => void;
  /** Stable ref used in GitDialogHost onCreateBranch callback. */
  onCreateBranch: (wid: string, name: string, fromRef?: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGitPanelActions({
  workspaceId,
  dialogs,
  pickers,
  derived,
}: GitPanelActionsInput): GitPanelActions {
  const {
    setDiscardRequest,
    setBranchCreateRequest,
    setBranchCreateBranchList,
    setBranchCreateBranchListLoading,
    mergeOptionsRequest,
    setMergeOptionsRequest,
    setPublishRequest,
    setStashGroupRequest,
    setForcePushRequest,
    setContextBanner,
    setRemoveRemoteRequest,
  } = dialogs;

  const {
    setBranchPickerMode,
    setBranchPickerOpen,
    setTagPickerMode,
    setTagPickerRemote,
    setTagPickerOpen,
  } = pickers;

  // Store actions — grouped by concern using useShallow
  const commitOps = useGitStore(
    useShallow((s) => ({
      commit: s.commit,
      commitAmend: s.commitAmend,
      stage: s.stage,
      setCommitDraft: s.setCommitDraft,
    })),
  );

  const pushPullOps = useGitStore(
    useShallow((s) => ({
      push: s.push,
      pull: s.pull,
      sync: s.sync,
      fetchAll: s.fetchAll,
    })),
  );

  const branchOps = useGitStore(
    useShallow((s) => ({
      listBranches: s.listBranches,
      createBranch: s.createBranch,
      init: s.init,
      merge: s.merge,
      listRecentCommits: s.listRecentCommits,
    })),
  );

  const panelUiOps = useGitStore(
    useShallow((s) => ({
      setPanelSegment: s.setPanelSegment,
      setHistoryRef: s.setHistoryRef,
      clearPendingNonFFRetry: s.clearPendingNonFFRetry,
    })),
  );

  // Race guard for the branch-create dialog's async list load
  const branchCreateLoadIdRef = useRef(0);

  // ---------------------------------------------------------------------------
  // Branch-create dialog lifecycle
  // ---------------------------------------------------------------------------

  const openBranchCreateDialog = useCallback(
    (fromRef?: string) => {
      const loadId = branchCreateLoadIdRef.current + 1;
      branchCreateLoadIdRef.current = loadId;
      setBranchCreateRequest(fromRef ? { fromRef } : {});
      setBranchCreateBranchList(null);
      setBranchCreateBranchListLoading(true);

      void branchOps.listBranches(workspaceId)
        .then((list) => {
          if (branchCreateLoadIdRef.current !== loadId) return;
          setBranchCreateBranchList(list ?? null);
        })
        .catch(() => {
          if (branchCreateLoadIdRef.current !== loadId) return;
          setBranchCreateBranchList(null);
        })
        .finally(() => {
          if (branchCreateLoadIdRef.current !== loadId) return;
          setBranchCreateBranchListLoading(false);
        });
    },
    [
      branchOps.listBranches,
      setBranchCreateBranchList,
      setBranchCreateBranchListLoading,
      setBranchCreateRequest,
      workspaceId,
    ],
  );

  const closeBranchCreateDialog = useCallback(() => {
    branchCreateLoadIdRef.current += 1;
    setBranchCreateRequest(null);
    setBranchCreateBranchListLoading(false);
  }, [setBranchCreateBranchListLoading, setBranchCreateRequest]);

  // ---------------------------------------------------------------------------
  // Picker launchers
  // ---------------------------------------------------------------------------

  const openBranchPicker = useCallback(
    (mode: BranchPickerMode): void => {
      setBranchPickerMode(mode);
      setBranchPickerOpen(true);
    },
    [setBranchPickerMode, setBranchPickerOpen],
  );

  const openTagPicker = useCallback(
    (mode: TagPickerMode, remote?: string): void => {
      setTagPickerMode(mode);
      setTagPickerRemote(mode === "delete-remote" ? (remote ?? null) : null);
      setTagPickerOpen(true);
    },
    [setTagPickerMode, setTagPickerRemote, setTagPickerOpen],
  );

  // ---------------------------------------------------------------------------
  // Push / publish
  // ---------------------------------------------------------------------------

  const requestPush = useCallback(
    async (options: GitPushOptions = {}): Promise<void> => {
      if (options.force) {
        setForcePushRequest(options);
        return;
      }
      if (
        !options.publish &&
        !derived.hasUpstream &&
        derived.capabilitiesRemotes.length > 0 &&
        derived.capabilitiesHasHEAD &&
        derived.currentBranchName
      ) {
        const prompt = buildPublishBranchPrompt(
          derived.currentBranchName,
          derived.capabilitiesRemotes,
        );
        if (prompt) setPublishRequest(prompt);
        return;
      }
      await pushPullOps.push(workspaceId, options);
    },
    [
      derived.capabilitiesHasHEAD,
      derived.capabilitiesRemotes,
      derived.currentBranchName,
      derived.hasUpstream,
      pushPullOps.push,
      setForcePushRequest,
      setPublishRequest,
      workspaceId,
    ],
  );

  // ---------------------------------------------------------------------------
  // Merge
  // ---------------------------------------------------------------------------

  const confirmMergeOption = useCallback(
    async (mode: GitMergeMode): Promise<void> => {
      const request = mergeOptionsRequest;
      setMergeOptionsRequest(null);
      if (!request) return;

      const squashCommits =
        mode === "squash"
          ? ((await branchOps.listRecentCommits(workspaceId, undefined, request.targetRef)) ?? [])
          : [];
      const result = await branchOps.merge(workspaceId, request.targetRef, mode);
      if (mode === "squash" && result?.result === "clean") {
        commitOps.setCommitDraft(
          workspaceId,
          buildSquashCommitDraft(request.targetRef, squashCommits),
        );
      }
    },
    [
      branchOps.listRecentCommits,
      branchOps.merge,
      commitOps.setCommitDraft,
      mergeOptionsRequest,
      setMergeOptionsRequest,
      workspaceId,
    ],
  );

  // ---------------------------------------------------------------------------
  // Commit operations
  // ---------------------------------------------------------------------------

  const handleCommitStaged = useCallback(async (): Promise<void> => {
    if (derived.trimmedDraft.length === 0 || !derived.hasStagedChanges) return;
    await commitOps.commit(workspaceId, { message: derived.trimmedDraft });
  }, [commitOps.commit, derived.hasStagedChanges, derived.trimmedDraft, workspaceId]);

  const handleCommitAll = useCallback(async (): Promise<void> => {
    if (derived.trimmedDraft.length === 0) return;
    if (derived.stageablePaths.length > 0) {
      await commitOps.stage(workspaceId, derived.stageablePaths);
    }
    await commitOps.commit(workspaceId, { message: derived.trimmedDraft });
  }, [commitOps.commit, derived.stageablePaths, derived.trimmedDraft, commitOps.stage, workspaceId]);

  const handleAmend = useCallback(async (): Promise<void> => {
    await commitOps.commitAmend(workspaceId, { message: derived.trimmedDraft });
  }, [commitOps.commitAmend, derived.trimmedDraft, workspaceId]);

  const handleCommitAndPush = useCallback(async (): Promise<void> => {
    if (derived.trimmedDraft.length === 0 || !derived.hasStagedChanges) return;
    const result = await commitOps.commit(workspaceId, { message: derived.trimmedDraft });
    if (result) await requestPush();
  }, [commitOps.commit, derived.hasStagedChanges, derived.trimmedDraft, requestPush, workspaceId]);

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  const handleSync = useCallback(async (): Promise<void> => {
    const result = await pushPullOps.sync(workspaceId);
    if (result?.pulled === "cancelled") {
      setContextBanner({ variant: "info", message: "Sync cancelled (pull aborted before push)." });
    }
  }, [pushPullOps.sync, setContextBanner, workspaceId]);

  // ---------------------------------------------------------------------------
  // Discard / remove-remote / stash-group prompts
  // ---------------------------------------------------------------------------

  const requestDiscard = useCallback(
    (paths: string[], description: string, source?: string): void => {
      if (paths.length === 0) return;
      const count = paths.length;
      setDiscardRequest({
        relPaths: paths,
        ...(source ? { source: source as GitExpandedGroupKey } : {}),
        title: count === 1 ? "Discard changes?" : `Discard ${count} changes?`,
        description:
          count === 1
            ? `Discard changes in ${description}? This cannot be undone.`
            : `Discard all changes in ${description}? This cannot be undone.`,
      });
    },
    [setDiscardRequest],
  );

  const requestRemoveRemote = useCallback(
    (remote: string): void => {
      const upstreamWarning = buildRemoteUpstreamWarning(derived.branchInfo, remote);
      const baseDescription = `Remote '${remote}' will be removed from this repository.`;
      setRemoveRemoteRequest({
        remote,
        confirm: {
          relPaths: [remote],
          title: `Remove remote '${remote}'?`,
          description: upstreamWarning
            ? `${upstreamWarning} ${baseDescription}`
            : baseDescription,
          confirmLabel: "Remove",
        },
      });
    },
    [derived.branchInfo, setRemoveRemoteRequest],
  );

  const requestStashGroup = useCallback(
    (paths: string[], label: string): void => {
      if (paths.length === 0) return;
      setStashGroupRequest({
        paths,
        prompt: {
          title: "Stash changes in group",
          description: `Stash only ${label.toLowerCase()} and leave other working tree changes in place.`,
          label: "Message",
          placeholder: "Optional stash message",
          confirmLabel: "Stash",
          allowEmpty: true,
        },
      });
    },
    [setStashGroupRequest],
  );

  // ---------------------------------------------------------------------------
  // Tag → History retargeting
  // ---------------------------------------------------------------------------

  const revealTagInHistory = useCallback(
    (tag: Tag): void => {
      const ref = tagHistoryRef(tag);
      panelUiOps.setHistoryRef(workspaceId, ref);
      panelUiOps.setPanelSegment(workspaceId, "history");
      setTagPickerOpen(false);
      setContextBanner({
        variant: "info",
        message: buildTagHistoryRevealMessage(tag),
      });
    },
    [
      panelUiOps.setHistoryRef,
      panelUiOps.setPanelSegment,
      setContextBanner,
      setTagPickerOpen,
      workspaceId,
    ],
  );

  // ---------------------------------------------------------------------------
  // Push-guard banner dispatch
  // ---------------------------------------------------------------------------

  const runPushGuardAction = useCallback(
    (kind: PushGuardActionKind): void => {
      switch (kind) {
        case "pull":
          void pushPullOps.pull(workspaceId);
          break;
        case "force":
          void requestPush({
            ...(derived.pendingNonFFRetry?.originalPushOpts ?? {}),
            force: true,
          });
          break;
        case "cancel":
          panelUiOps.clearPendingNonFFRetry(workspaceId);
          break;
        case "retry":
          if (derived.pendingNonFFRetry) {
            void pushPullOps.push(workspaceId, derived.pendingNonFFRetry.originalPushOpts);
          }
          break;
        case "fetch":
          void pushPullOps.fetchAll(workspaceId);
          break;
      }
    },
    [
      derived.pendingNonFFRetry,
      panelUiOps.clearPendingNonFFRetry,
      pushPullOps.fetchAll,
      pushPullOps.pull,
      pushPullOps.push,
      requestPush,
      workspaceId,
    ],
  );

  // ---------------------------------------------------------------------------
  // Primary-action dispatch
  // ---------------------------------------------------------------------------

  const runPrimaryAction = useCallback((): void => {
    switch (derived.actionStateKind) {
      case "initialize-repository":
        void branchOps.init(workspaceId);
        break;
      case "make-initial-commit":
      case "commit":
        void handleCommitStaged();
        break;
      case "stage-all":
        void commitOps.stage(workspaceId, derived.stageablePaths);
        break;
      case "sync":
        void handleSync();
        break;
      case "push":
      case "publish-branch":
        void requestPush();
        break;
      case "pull":
        void pushPullOps.pull(workspaceId);
        break;
      case "commit-disabled":
      case "no-remote":
      case "up-to-date":
        break;
    }
  }, [
    branchOps.init,
    derived.actionStateKind,
    derived.stageablePaths,
    handleCommitStaged,
    handleSync,
    pushPullOps.pull,
    requestPush,
    commitOps.stage,
    workspaceId,
  ]);

  // ---------------------------------------------------------------------------
  // GitDialogHost create-branch callback
  // ---------------------------------------------------------------------------

  const onCreateBranch = useCallback(
    async (_wid: string, name: string, fromRef?: string): Promise<void> => {
      await submitBranchCreate({
        workspaceId,
        name,
        fromRef,
        createBranch: branchOps.createBranch,
      });
    },
    [branchOps.createBranch, workspaceId],
  );

  return {
    openBranchCreateDialog,
    closeBranchCreateDialog,
    openBranchPicker,
    openTagPicker,
    requestPush,
    confirmMergeOption,
    handleCommitStaged,
    handleCommitAll,
    handleAmend,
    handleCommitAndPush,
    handleSync,
    requestDiscard,
    requestRemoveRemote,
    requestStashGroup,
    revealTagInHistory,
    runPushGuardAction,
    runPrimaryAction,
    onCreateBranch,
  };
}
