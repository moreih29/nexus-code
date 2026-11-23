import i18next from "i18next";
import { useCallback, useRef } from "react";
import { useShallow } from "zustand/shallow";
import type {
  BranchInfo,
  GitExpandedGroupKey,
  GitMergeMode,
  Tag,
} from "../../../../../shared/git/types";
import type { GitPushOptions } from "../../../../state/stores/git";
import { useGitStore } from "../../../../state/stores/git";
import { getCommitDraft } from "../../../../state/stores/git/commit-drafts";
import { submitBranchCreate } from "../branch/create-dialog";
import type { BranchPickerMode } from "../branch/picker";
import { buildSquashCommitDraft } from "../pickers/merge-options-dialog";
import type { TagPickerMode } from "../pickers/tag-picker-source";
import type { GitPanelPickersState } from "../pickers/use-panel-pickers";
import { buildRemoteUpstreamWarning } from "../utils/more-menu-model";
import type { PushGuardActionKind } from "../utils/push-guard-banner";
import {
  buildPublishBranchPrompt,
  buildTagHistoryRevealMessage,
  tagHistoryRef,
} from "./panel-actions";
import type { GitDialogsState } from "./use-dialogs";

export interface GitPanelActionsInput {
  workspaceId: string;
  dialogs: GitDialogsState;
  pickers: GitPanelPickersState;
  derived: {
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
  openBranchCreateDialog: (fromRef?: string) => void;
  closeBranchCreateDialog: () => void;
  openBranchPicker: (mode: BranchPickerMode) => void;
  openTagPicker: (mode: TagPickerMode, remote?: string) => void;
  requestPush: (options?: GitPushOptions) => Promise<void>;
  confirmMergeOption: (mode: GitMergeMode) => Promise<void>;
  handleCommitStaged: () => Promise<void>;
  handleCommitAll: () => Promise<void>;
  handleAmend: () => Promise<void>;
  handleCommitAndPush: () => Promise<void>;
  handleSync: () => Promise<void>;
  requestDiscard: (paths: string[], description: string, source?: string) => void;
  requestRemoveRemote: (remote: string) => void;
  requestStashGroup: (paths: string[], label: string) => void;
  revealTagInHistory: (tag: Tag) => void;
  runPushGuardAction: (kind: PushGuardActionKind) => void;
  runPrimaryAction: () => void;
  onCreateBranch: (wid: string, name: string, fromRef?: string) => Promise<void>;
}

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

  const branchCreateLoadIdRef = useRef(0);

  const openBranchCreateDialog = useCallback(
    (fromRef?: string) => {
      const loadId = branchCreateLoadIdRef.current + 1;
      branchCreateLoadIdRef.current = loadId;
      setBranchCreateRequest(fromRef ? { fromRef } : {});
      setBranchCreateBranchList(null);
      setBranchCreateBranchListLoading(true);

      void branchOps
        .listBranches(workspaceId)
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

  const handleCommitStaged = useCallback(async (): Promise<void> => {
    const message = getCommitDraft(workspaceId).trim();
    if (message.length === 0 || !derived.hasStagedChanges) return;
    await commitOps.commit(workspaceId, { message });
  }, [commitOps.commit, derived.hasStagedChanges, workspaceId]);

  const handleCommitAll = useCallback(async (): Promise<void> => {
    const message = getCommitDraft(workspaceId).trim();
    if (message.length === 0) return;
    if (derived.stageablePaths.length > 0) {
      await commitOps.stage(workspaceId, derived.stageablePaths);
    }
    await commitOps.commit(workspaceId, { message });
  }, [commitOps.commit, derived.stageablePaths, commitOps.stage, workspaceId]);

  const handleAmend = useCallback(async (): Promise<void> => {
    await commitOps.commitAmend(workspaceId, { message: getCommitDraft(workspaceId).trim() });
  }, [commitOps.commitAmend, workspaceId]);

  const handleCommitAndPush = useCallback(async (): Promise<void> => {
    const message = getCommitDraft(workspaceId).trim();
    if (message.length === 0 || !derived.hasStagedChanges) return;
    const result = await commitOps.commit(workspaceId, { message });
    if (result) await requestPush();
  }, [commitOps.commit, derived.hasStagedChanges, requestPush, workspaceId]);

  const handleSync = useCallback(async (): Promise<void> => {
    const result = await pushPullOps.sync(workspaceId);
    if (result?.pulled === "cancelled") {
      setContextBanner({
        variant: "info",
        message: i18next.t("files:git.panelActions.syncCancelled"),
      });
    }
  }, [pushPullOps.sync, setContextBanner, workspaceId]);

  const requestDiscard = useCallback(
    (paths: string[], description: string, source?: string): void => {
      if (paths.length === 0) return;
      const t = i18next.t.bind(i18next);
      const count = paths.length;
      setDiscardRequest({
        relPaths: paths,
        ...(source ? { source: source as GitExpandedGroupKey } : {}),
        title: t("files:git.discard.title", { count }),
        description: t("files:git.discard.description", { count, description }),
      });
    },
    [setDiscardRequest],
  );

  const requestRemoveRemote = useCallback(
    (remote: string): void => {
      const t = i18next.t.bind(i18next);
      const upstreamWarning = buildRemoteUpstreamWarning(derived.branchInfo, remote);
      const baseDescription = t("files:git.removeRemote.baseDescription", { remote });
      setRemoveRemoteRequest({
        remote,
        confirm: {
          relPaths: [remote],
          title: t("files:git.removeRemote.title", { remote }),
          description: upstreamWarning ? `${upstreamWarning} ${baseDescription}` : baseDescription,
          confirmLabel: t("files:git.removeRemote.confirmLabel"),
        },
      });
    },
    [derived.branchInfo, setRemoveRemoteRequest],
  );

  const requestStashGroup = useCallback(
    (paths: string[], label: string): void => {
      if (paths.length === 0) return;
      const t = i18next.t.bind(i18next);
      setStashGroupRequest({
        paths,
        prompt: {
          title: t("files:git.stashGroup.title"),
          description: t("files:git.stashGroup.description", { label: label.toLowerCase() }),
          label: t("files:git.stashGroup.messageLabel"),
          placeholder: t("files:git.stashGroup.messagePlaceholder"),
          confirmLabel: t("files:git.stashGroup.confirmLabel"),
          allowEmpty: true,
        },
      });
    },
    [setStashGroupRequest],
  );

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
