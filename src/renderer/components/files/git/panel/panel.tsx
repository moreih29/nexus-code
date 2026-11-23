import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { validateGitRemoteUrl } from "../../../../../shared/git/remote-validation";
import {
  DEFAULT_GIT_PANEL_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitExpandedGroupKey,
  type GitStatusEntry,
  type RepoCapabilities,
} from "../../../../../shared/git/types";
import { bannerEventId, useBannerDismissal } from "../../../../hooks/use-banner-dismissal";
import { useStableHandlers } from "../../../../hooks/use-stable-handlers";
import { gitErrorPlacement } from "../../../../services/error-surface/git-error-placement";
import { useGitSession, useGitStore } from "../../../../state/stores/git";
import { selectGitActionButton } from "../../../../state/stores/git/action-button";
import { getCommitDraft, useCommitDraftStore } from "../../../../state/stores/git/commit-drafts";
import {
  usePanelViewOptionsStore,
  useViewOptions,
} from "../../../../state/stores/panel-view-options";
import { useWorkspacesStore } from "../../../../state/stores/workspaces";
import { EmptyState } from "../../../ui/empty-state";
import type { FormDialogField } from "../../../ui/form-dialog";
import { Skeleton, SkeletonLine } from "../../../ui/skeleton";
import { useLoaderDelay } from "../../search/use-loader-delay";
import { createCommitPickerSource } from "../commit/picker-source";
import type { GitGroupActions } from "../file-row/group";
import { useGitHelperOccupancy } from "../hooks/use-helper-prompts";
import { useGitOpHotkey } from "../hooks/use-op-hotkey";
import { createMergeTargetPickerSource } from "../pickers/merge-target-picker-source";
import { createRebaseTargetPickerSource } from "../pickers/rebase-target-picker-source";
import { useGitPanelPickers } from "../pickers/use-panel-pickers";
import { buildPushGuardBannerView } from "../utils/push-guard-banner";
import { buildGitGroups, collectGitEntryPaths } from "../utils/status-utils";
import { buildGitBannerModel } from "./banner-model";
import { GitBannerStack } from "./banner-stack";
import { GitDialogHost } from "./dialog-host";
import { createEntryActions } from "./entry-actions";
import { GitMissingState } from "./git-missing-state";
import { GitHeader } from "./header";
import { buildErrorAction } from "./panel-actions";
import { GitPanelBody } from "./panel-body";
import { useGitDialogs } from "./use-dialogs";
import { useGitPanelActions } from "./use-panel-actions";

export interface GitPanelOpenDiffInput {
  workspaceId: string;
  groupKey: GitExpandedGroupKey;
  entry: GitStatusEntry;
  preview?: boolean;
}

interface GitPanelProps {
  workspaceId: string;
  workspaceRootPath?: string;
  onOpenDiff?: (input: GitPanelOpenDiffInput) => void;
}

export function GitPanel({ workspaceId, workspaceRootPath, onOpenDiff }: GitPanelProps) {
  const { t } = useTranslation("files");
  const session = useGitSession(workspaceId);
  const helperPromptOccupancyMessage = useGitHelperOccupancy(workspaceId);
  const remoteWorkspace = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location.kind !== "local",
  );

  const { loadInitial } = useGitStore(useShallow((s) => ({ loadInitial: s.loadInitial })));

  const directOps = useGitStore(
    useShallow((s) => ({
      refresh: s.refresh,
      init: s.init,
      stage: s.stage,
      unstage: s.unstage,
      discard: s.discard,
      commit: s.commit,
      commitEmpty: s.commitEmpty,
      undoLastCommit: s.undoLastCommit,
      fetchAll: s.fetchAll,
      pull: s.pull,
      push: s.push,
      pushTags: s.pushTags,
      stash: s.stash,
      stashPop: s.stashPop,
      stashGroup: s.stashGroup,
      rebase: s.rebase,
      cherryPick: s.cherryPick,
      continueOp: s.continueOp,
      abortOp: s.abortOp,
      markResolved: s.markResolved,
      listBranches: s.listBranches,
      listRecentCommits: s.listRecentCommits,
      addRemote: s.addRemote,
      removeRemote: s.removeRemote,
      createBranch: s.createBranch,
    })),
  );

  const panelUiOps = useGitStore(
    useShallow((s) => ({
      setCommitDraft: s.setCommitDraft,
      flushCommitDraft: s.flushCommitDraft,
      setCommitOption: s.setCommitOption,
      setAutofetchInterval: s.setAutofetchInterval,
      resumeAutofetch: s.resumeAutofetch,
      setPanelSegment: s.setPanelSegment,
      setHistoryRef: s.setHistoryRef,
      setExpandedGroup: s.setExpandedGroup,
      toggleExpandedTreeNode: s.toggleExpandedTreeNode,
      expandAllTrees: s.expandAllTrees,
      collapseAllTrees: s.collapseAllTrees,
    })),
  );

  const viewOptActions = usePanelViewOptionsStore(
    useShallow((s) => ({
      setViewMode: s.setViewMode,
      loadViewOptions: s.loadViewOptions,
    })),
  );

  useEffect(() => {
    void loadInitial(workspaceId);
  }, [loadInitial, workspaceId]);

  useEffect(() => {
    viewOptActions.loadViewOptions("git", workspaceId);
  }, [viewOptActions.loadViewOptions, workspaceId]);

  const viewOptions = useViewOptions("git", workspaceId);

  const groups = useMemo(() => buildGitGroups(session?.status), [session?.status]);
  const allChangedPaths = useMemo(
    () => collectGitEntryPaths(groups.flatMap((group) => group.entries)),
    [groups],
  );
  const stageablePaths = useMemo(
    () =>
      collectGitEntryPaths(
        groups
          .filter(
            (group) =>
              group.key === "working" || group.key === "untracked" || group.key === "merge",
          )
          .flatMap((group) => group.entries),
      ),
    [groups],
  );
  const hasChanges = allChangedPaths.length > 0;
  const hasStagedChanges = (session?.status?.staged.length ?? 0) > 0;
  const expandedTreeNodes = session?.expandedTreeNodes;
  const hasAnyExpanded = useMemo(() => {
    if (!expandedTreeNodes) return false;
    return (
      expandedTreeNodes.merge.length > 0 ||
      expandedTreeNodes.staged.length > 0 ||
      expandedTreeNodes.working.length > 0 ||
      expandedTreeNodes.untracked.length > 0
    );
  }, [expandedTreeNodes]);
  const capabilities: RepoCapabilities = session?.status?.capabilities ?? DEFAULT_REPO_CAPABILITIES;
  const branchInfo = session?.branchInfo ?? null;
  const hasUpstream = branchInfo?.upstream != null;
  const isBusy = session?.inFlightOp !== null && session?.inFlightOp !== undefined;
  const isRefreshing = session?.inFlightOp?.kind === "refresh" || Boolean(session?.statusFetching);
  const isLoading = !session || session.repoInfo.kind === "detecting" || session.statusFetching;
  const showSkeleton = useLoaderDelay(isLoading ? "running" : "done");
  const hasDraft = useCommitDraftStore((s) => (s.drafts.get(workspaceId) ?? "").trim().length > 0);
  const operationState = session?.status?.operationState ?? { kind: "none" as const };
  const activeOperation = operationState.kind === "none" ? null : operationState;
  const hasActiveOperation = activeOperation !== null;
  const actionState = useMemo(
    () =>
      selectGitActionButton(
        {
          repoKind: session?.repoInfo.kind ?? "detecting",
          capabilities,
          branch: branchInfo,
          dirty: {
            staged: session?.status?.staged.length ?? 0,
            working: session?.status?.working.length ?? 0,
            untracked: session?.status?.untracked.length ?? 0,
            merge: session?.status?.merge.length ?? 0,
          },
          hasDraft,
        },
        (key) => t(key),
      ),
    [branchInfo, capabilities, hasDraft, session?.repoInfo.kind, session?.status, t],
  );
  const commitActionEnabled =
    (actionState.kind === "commit" || actionState.kind === "make-initial-commit") &&
    !actionState.disabled;
  const commitOptions = session?.commitOptions ?? DEFAULT_GIT_PANEL_STATE.commitOptions;
  const repoPath = session?.repoInfo.kind === "repo" ? session.repoInfo.topLevel : undefined;
  const currentBranchName = branchInfo?.current ?? null;
  const hasRemote = capabilities.remotes.length > 0;

  const dialogs = useGitDialogs();
  const { setAddRemoteOpen, setEmptyCommitRequest, contextBanner, setContextBanner } = dialogs;

  const pickers = useGitPanelPickers();
  const {
    setMergeTargetPickerOpen,
    setRebaseTargetPickerOpen,
    commitPickerRef,
    setCommitPickerRef,
    setCommitPickerOpen,
    setCommitBranchPickerOpen,
    setBranchCreateFromPickerOpen,
    setStashPickerMode,
    setStashPickerOpen,
  } = pickers;

  const actions = useGitPanelActions({
    workspaceId,
    dialogs,
    pickers,
    derived: {
      hasStagedChanges,
      stageablePaths,
      allChangedPaths,
      hasUpstream,
      hasRemote,
      capabilitiesHasHEAD: capabilities.hasHEAD,
      capabilitiesRemotes: capabilities.remotes,
      currentBranchName,
      actionStateKind: actionState.kind,
      pendingNonFFRetry: session?.pendingNonFFRetry,
      branchInfo,
    },
  });

  const {
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
    requestDiscard,
    requestRemoveRemote,
    requestStashGroup,
    revealTagInHistory,
    runPushGuardAction,
    runPrimaryAction,
    onCreateBranch,
  } = actions;

  const entryActions = useMemo(
    () =>
      createEntryActions({
        workspaceId,
        repoPath,
        workspaceRootPath,
        onOpenDiff,
        setBanner: setContextBanner,
      }),
    [workspaceId, repoPath, workspaceRootPath, onOpenDiff, setContextBanner],
  );
  const {
    openChanges,
    openWorkingTreeFile,
    revealEntryInOS,
    copyEntryPath,
    copyEntryRelativePath,
    addEntryToGitignore,
    addPathsToGitignore,
  } = entryActions;

  const mergeTargetSource = useMemo(
    () =>
      createMergeTargetPickerSource({
        workspaceId,
        currentBranch: currentBranchName,
        listBranches: directOps.listBranches,
        acceptTarget: (targetRef) => {
          dialogs.setMergeOptionsRequest({ targetRef });
        },
      }),
    [currentBranchName, directOps.listBranches, dialogs.setMergeOptionsRequest, workspaceId],
  );
  const rebaseTargetSource = useMemo(
    () =>
      createRebaseTargetPickerSource({
        workspaceId,
        currentBranch: currentBranchName,
        listBranches: directOps.listBranches,
        acceptTarget: (targetRef) => {
          void directOps.rebase(workspaceId, targetRef);
        },
      }),
    [currentBranchName, directOps.listBranches, directOps.rebase, workspaceId],
  );
  const commitPickerSource = useMemo(
    () =>
      createCommitPickerSource({
        workspaceId,
        currentBranch: currentBranchName,
        ref: commitPickerRef,
        listRecentCommits: directOps.listRecentCommits,
        acceptCommit: (sha) => {
          void directOps.cherryPick(workspaceId, sha);
        },
        requestBranch: () => {
          setCommitBranchPickerOpen(true);
        },
      }),
    [
      directOps.cherryPick,
      commitPickerRef,
      currentBranchName,
      directOps.listRecentCommits,
      workspaceId,
      setCommitBranchPickerOpen,
    ],
  );
  const commitBranchSource = useMemo(
    () =>
      createMergeTargetPickerSource({
        workspaceId,
        currentBranch: currentBranchName,
        title: t("git.commitPicker.pickFromBranch"),
        placeholder: t("git.commitPicker.pickFromBranchPlaceholder"),
        listBranches: directOps.listBranches,
        acceptTarget: (targetRef) => {
          setCommitPickerRef(targetRef);
          setCommitPickerOpen(true);
        },
      }),
    [
      currentBranchName,
      directOps.listBranches,
      workspaceId,
      setCommitPickerRef,
      setCommitPickerOpen,
      t,
    ],
  );
  const addRemoteFields = useMemo<FormDialogField[]>(
    () => [
      { name: "name", label: t("git.moreMenu.remote.label"), placeholder: "origin" },
      {
        name: "url",
        label: "URL",
        placeholder: "https://github.com/org/repo.git",
        validate: validateGitRemoteUrl,
      },
    ],
    [t],
  );

  const errorAction = buildErrorAction(session?.lastError, {
    workspaceId,
    cwd: repoPath ?? workspaceRootPath,
    onRetry: () => {
      void directOps.refresh(workspaceId);
    },
  });
  const panelError =
    session?.lastError &&
    gitErrorPlacement(session.lastError) !== "toast" &&
    !(session.repoInfo.kind === "git-missing" && session.lastError.kind === "git-missing")
      ? session.lastError
      : null;
  const pushGuardBanner = buildPushGuardBannerView({
    error: session?.lastError,
    pendingNonFFRetry: session?.pendingNonFFRetry,
    inFlightKind: session?.inFlightOp?.kind ?? null,
  });

  const gitNoticeScope = ["git", workspaceId, repoPath];
  const pushNotice = useBannerDismissal(
    [...gitNoticeScope, "push-guard"],
    pushGuardBanner
      ? [bannerEventId(session?.lastError), session?.pendingNonFFRetry?.attemptedAt]
      : undefined,
  );
  const errorNotice = useBannerDismissal(
    [...gitNoticeScope, "error"],
    panelError ? [bannerEventId(panelError)] : undefined,
  );
  const autofetchNotice = useBannerDismissal(
    [...gitNoticeScope, "autofetch-paused"],
    session?.autofetchPausedBannerVisible ? [session.autofetchLastError?.message] : undefined,
    true,
  );
  const contextNotice = useBannerDismissal(
    [...gitNoticeScope, "context"],
    contextBanner ? [bannerEventId(contextBanner)] : undefined,
  );
  const operationNotice = useBannerDismissal(
    [...gitNoticeScope, "operation"],
    activeOperation
      ? [JSON.stringify(activeOperation), bannerEventId(session?.lastError)]
      : undefined,
    true,
  );

  const handlePanelKeyDown = useGitOpHotkey({
    disabled: isBusy || hasActiveOperation || !commitActionEnabled,
    onCommit: () => {
      void handleCommitStaged();
    },
  });

  const fileActions = useStableHandlers<Omit<GitGroupActions, "openMenu">>({
    toggleGroup: (key) =>
      panelUiOps.setExpandedGroup(workspaceId, key, !(session?.expandedGroups[key] ?? false)),
    toggleTreeNode: (key, relPath) => panelUiOps.toggleExpandedTreeNode(workspaceId, key, relPath),
    stage: (paths) => {
      void directOps.stage(workspaceId, paths);
    },
    unstage: (paths) => {
      void directOps.unstage(workspaceId, paths);
    },
    discard: requestDiscard,
    markResolved: (entry) => {
      void directOps.markResolved(workspaceId, [entry.relPath]);
    },
    openDiff: (entry, groupKey, opts) => {
      openChanges(entry, groupKey, opts);
    },
    openFile: openWorkingTreeFile,
    revealInOS: revealEntryInOS,
    copyPath: copyEntryPath,
    copyRelativePath: copyEntryRelativePath,
    addToGitignore: addEntryToGitignore,
    addPathsToGitignore: (paths) => {
      void addPathsToGitignore(paths);
    },
    stashGroup: requestStashGroup,
  });

  const headerDisabled = isBusy || isLoading;
  const isRepo = session?.repoInfo.kind === "repo";
  const { viewMode } = viewOptions;
  const panelSegment = session?.panelSegment ?? DEFAULT_GIT_PANEL_STATE.panelSegment;
  const historyRef = session?.historyRef ?? DEFAULT_GIT_PANEL_STATE.historyRef;
  const menuEnablement = {
    canCommitStaged: hasDraft && hasStagedChanges,
    canCommitAll: hasDraft && (hasStagedChanges || stageablePaths.length > 0),
    canCommitAndPush: hasDraft && hasStagedChanges && hasRemote,
    canPush: hasRemote && capabilities.hasHEAD,
    canPull: hasRemote,
  };

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t("git.panel.ariaLabel")}
      onKeyDown={handlePanelKeyDown}
    >
      <GitHeader
        disabled={headerDisabled}
        refreshing={isRefreshing}
        canInit={session?.repoInfo.kind === "non-repo"}
        gitMissing={session?.repoInfo.kind === "git-missing"}
        hasChanges={hasChanges}
        capabilities={capabilities}
        showViewToggle={isRepo}
        viewMode={viewMode}
        onViewModeChange={(next) => viewOptActions.setViewMode("git", workspaceId, next)}
        hasAnyExpanded={hasAnyExpanded}
        onToggleAllTrees={() => {
          if (hasAnyExpanded) panelUiOps.collapseAllTrees(workspaceId);
          else panelUiOps.expandAllTrees(workspaceId);
        }}
        onRefresh={() => {
          if (capabilities.remotes.length > 0) {
            void directOps.fetchAll(workspaceId);
          } else {
            void directOps.refresh(workspaceId);
          }
        }}
        onInit={() => {
          void directOps.init(workspaceId);
        }}
        onFetch={() => {
          void directOps.fetchAll(workspaceId);
        }}
        onPull={() => {
          void directOps.pull(workspaceId);
        }}
        onPush={() => {
          void requestPush();
        }}
        onStash={() => {
          void directOps.stash(workspaceId);
        }}
        onStashPop={() => {
          void directOps.stashPop(workspaceId);
        }}
        onOpenStashes={() => {
          setStashPickerMode("apply");
          setStashPickerOpen(true);
        }}
        onDropStash={() => {
          setStashPickerMode("drop");
          setStashPickerOpen(true);
        }}
        onOpenTags={(mode, remote) => openTagPicker(mode, remote)}
        onSwitchBranch={() => openBranchPicker("switch")}
        onMergeBranch={() => setMergeTargetPickerOpen(true)}
        onRebaseBranch={() => setRebaseTargetPickerOpen(true)}
        onCreateBranch={() => openBranchCreateDialog()}
        onCreateBranchFrom={() => setBranchCreateFromPickerOpen(true)}
        onRenameBranch={() => openBranchPicker("rename")}
        onDeleteBranch={() => openBranchPicker("delete-local")}
        onDeleteRemoteBranch={() => openBranchPicker("delete-remote")}
        onPushTags={(remote) => {
          void directOps.pushTags(workspaceId, remote);
        }}
        onAddRemote={() => setAddRemoteOpen(true)}
        onRemoveRemote={requestRemoveRemote}
        onDiscardAll={() => requestDiscard(allChangedPaths, "this repository")}
        autofetchIntervalMin={
          session?.autofetchIntervalMin ?? DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin
        }
        lastFetchedAt={session?.status?.lastFetchedAt ?? null}
        onSetAutofetchInterval={(intervalMin) => {
          void panelUiOps.setAutofetchInterval(workspaceId, intervalMin);
        }}
      />

      <GitBannerStack
        dismissals={{
          "push-guard": pushNotice.dismiss,
          error: errorNotice.dismiss,
          "autofetch-paused": autofetchNotice.dismiss,
          context: contextNotice.dismiss,
        }}
        model={buildGitBannerModel({
          pushGuardBanner: pushNotice.dismissed ? null : pushGuardBanner,
          onPushGuardAction: runPushGuardAction,
          lastError: pushGuardBanner || errorNotice.dismissed ? null : panelError,
          errorAction,
          autofetchPaused:
            !autofetchNotice.dismissed && (session?.autofetchPausedBannerVisible ?? false),
          autofetchLastErrorMessage: session?.autofetchLastError?.message,
          onResumeAutofetch: () => {
            void panelUiOps.resumeAutofetch(workspaceId);
          },
          helperPromptOccupancyMessage: helperPromptOccupancyMessage ?? null,
          contextBanner: contextNotice.dismissed ? null : contextBanner,
        })}
      />

      {isLoading ? (
        <div className="min-h-0 flex-1">
          {showSkeleton ? (
            <Skeleton label={t("git.panel.skeleton.loading")}>
              <SkeletonLine className="h-[82px] rounded-(--radius-raised) border border-border" />
              <div className="flex flex-col gap-1">
                <SkeletonLine className="h-7" />
                {Array.from({ length: 5 }).map((_, index) => (
                  <SkeletonLine
                    // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton row count.
                    key={index}
                    className="h-6"
                    style={{ opacity: 1 - index * 0.12 }}
                  />
                ))}
              </div>
            </Skeleton>
          ) : null}
        </div>
      ) : session?.repoInfo.kind === "git-missing" ? (
        <GitMissingState remote={remoteWorkspace} />
      ) : session?.repoInfo.kind === "non-repo" ? (
        <EmptyState
          title={t("git.panel.nonRepo.title")}
          description={t("git.panel.nonRepo.description")}
          actionLabel={actionState.label}
          disabled={isBusy}
          onAction={() => {
            runPrimaryAction();
          }}
        />
      ) : (
        <GitPanelBody
          workspaceId={workspaceId}
          panelSegment={panelSegment}
          isBusy={isBusy}
          onSegmentChange={(segment) => panelUiOps.setPanelSegment(workspaceId, segment)}
          historyRef={historyRef}
          onHistoryRefChange={(nextRef) => panelUiOps.setHistoryRef(workspaceId, nextRef)}
          activeOperation={activeOperation}
          operationNotice={operationNotice}
          lastError={session?.lastError}
          inFlightKind={session?.inFlightOp?.kind}
          onContinueOp={() => {
            void directOps.continueOp(workspaceId);
          }}
          onAbortOp={() => {
            void directOps.abortOp(workspaceId);
          }}
          actionState={actionState}
          commitOptions={commitOptions}
          menuEnablement={menuEnablement}
          onDraftChange={(value) => panelUiOps.setCommitDraft(workspaceId, value)}
          onDraftBlur={() => panelUiOps.flushCommitDraft(workspaceId)}
          onPrimaryAction={runPrimaryAction}
          onCommitStaged={() => void handleCommitStaged()}
          onCommitAll={() => void handleCommitAll()}
          onAmend={() => void handleAmend()}
          onCommitAndPush={() => void handleCommitAndPush()}
          onCommitEmpty={() => {
            setEmptyCommitRequest({
              title: t("git.commit.emptyCommit.title"),
              description: t("git.commit.emptyCommit.description"),
              label: t("git.commit.emptyCommit.label"),
              placeholder: t("git.commit.emptyCommit.placeholder"),
              defaultValue: getCommitDraft(workspaceId).trim(),
              confirmLabel: t("git.commit.emptyCommit.confirmLabel"),
            });
          }}
          onUndoLastCommit={() => {
            void directOps.undoLastCommit(workspaceId);
          }}
          onToggleCommitOption={(option, value) =>
            panelUiOps.setCommitOption(workspaceId, option, value)
          }
          onPushOnly={() => {
            void requestPush();
          }}
          onPullOnly={() => {
            void directOps.pull(workspaceId);
          }}
          groups={groups}
          viewMode={viewMode}
          expandedGroups={session?.expandedGroups ?? {}}
          expandedTreeNodes={session?.expandedTreeNodes ?? {}}
          fileActions={fileActions}
        />
      )}

      <GitDialogHost
        dialogs={dialogs}
        pickers={pickers}
        callbacks={{
          workspaceId,
          onDiscard: (relPaths, source) => {
            void directOps.discard(workspaceId, relPaths, source);
          },
          onRemoveRemote: (remote) => {
            void directOps.removeRemote(workspaceId, remote);
          },
          onForcePush: (options) => {
            void directOps.push(workspaceId, options);
          },
          onOpenBranchCreateDialog: openBranchCreateDialog,
          onCloseBranchCreateDialog: closeBranchCreateDialog,
          onCreateBranch,
          onConfirmMergeOption: (mode) => {
            void confirmMergeOption(mode);
          },
          onConfirmPublish: () => {
            void directOps.push(workspaceId, { publish: true });
          },
          onConfirmEmptyCommit: (value) => {
            void directOps.commitEmpty(workspaceId, value);
          },
          onConfirmStashGroup: (paths, message) => {
            void directOps.stashGroup(workspaceId, paths, message);
          },
          onConfirmAddRemote: (name, url) => {
            void directOps.addRemote(workspaceId, name, url);
          },
          onRevealTagInHistory: revealTagInHistory,
          mergeTargetSource,
          rebaseTargetSource,
          commitPickerSource,
          commitBranchSource,
          addRemoteFields,
          discardBusy: session?.inFlightOp?.kind === "discard",
          removeRemoteBusy: session?.inFlightOp?.kind === "removeRemote",
          forcePushBusy: session?.inFlightOp?.kind === "push",
          branchCreateBusy: session?.inFlightOp?.kind === "createBranch",
          mergeBusy: session?.inFlightOp?.kind === "merge",
          publishBusy: session?.inFlightOp?.kind === "push",
          emptyCommitBusy: session?.inFlightOp?.kind === "commit",
          stashGroupBusy: session?.inFlightOp?.kind === "stashGroup",
          addRemoteBusy: session?.inFlightOp?.kind === "addRemote",
        }}
      />
    </section>
  );
}
