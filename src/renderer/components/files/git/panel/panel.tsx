/**
 * GitPanel is the top-level Source Control surface for one workspace.
 *
 * Thin container — orchestrates store selectors, derived state, and
 * inter-dialog callbacks, then delegates rendering to:
 *   GitHeader       — title + toolbar
 *   GitBannerStack  — inline banner row (unborn / push-guard / error / etc.)
 *   GitPanelBody    — segment toggle + commit input + file list + branch bar
 *   GitDialogHost   — all modal dialogs
 */
import { useEffect, useMemo } from "react";
import { validateGitRemoteUrl } from "../../../../../shared/git/remote-validation";
import {
  DEFAULT_GIT_PANEL_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitExpandedGroupKey,
  type GitStatusEntry,
  type RepoCapabilities,
} from "../../../../../shared/git/types";
import { selectGitActionButton } from "../../../../state/stores/git/action-button";
import { useGitStore } from "../../../../state/stores/git";
import {
  usePanelViewOptionsStore,
  useViewOptions,
} from "../../../../state/stores/panel-view-options";
import { EmptyState } from "../../../ui/empty-state";
import type { FormDialogField } from "../../../ui/form-dialog";
import { Skeleton, SkeletonLine } from "../../../ui/skeleton";
import { useShallow } from "zustand/shallow";
import { useLoaderDelay } from "../../search/use-loader-delay";
import { createCommitPickerSource } from "../commit/picker-source";
import { useGitHelperOccupancy } from "../hooks/use-helper-prompts";
import { useGitOpHotkey } from "../hooks/use-op-hotkey";
import { useGitSession } from "../../../../state/stores/git";
import { createMergeTargetPickerSource } from "../pickers/merge-target-picker-source";
import { createRebaseTargetPickerSource } from "../pickers/rebase-target-picker-source";
import { useGitPanelPickers } from "../pickers/use-panel-pickers";
import { buildPushGuardBannerView } from "../utils/push-guard-banner";
import { buildGitGroups, collectGitEntryPaths } from "../utils/status-utils";
import { createEntryActions } from "./entry-actions";
import { buildGitBannerModel } from "./banner-model";
import { GitBannerStack } from "./banner-stack";
import { GitDialogHost } from "./dialog-host";
import { GitHeader } from "./header";
import { buildErrorAction } from "./panel-actions";
import { GitPanelBody } from "./panel-body";
import { useGitDialogs } from "./use-dialogs";
import { useGitPanelActions } from "./use-panel-actions";

export interface GitPanelOpenDiffInput {
  workspaceId: string;
  groupKey: GitExpandedGroupKey;
  entry: GitStatusEntry;
}

interface GitPanelProps {
  workspaceId: string;
  workspaceRootPath?: string;
  /**
   * Integration seam for opening a diff view from the panel. When a parent
   * provides a handler the row's "open changes" action delegates to it,
   * keeping row rendering and git operations decoupled from the diff host.
   */
  onOpenDiff?: (input: GitPanelOpenDiffInput) => void;
}

export function GitPanel({ workspaceId, workspaceRootPath, onOpenDiff }: GitPanelProps) {
  const session = useGitSession(workspaceId);
  const helperPromptOccupancyMessage = useGitHelperOccupancy(workspaceId);

  // ---------------------------------------------------------------------------
  // Store — grouped selectors (session lifecycle / load)
  // ---------------------------------------------------------------------------
  const { loadInitial } = useGitStore(useShallow((s) => ({ loadInitial: s.loadInitial })));

  // Operations needed directly in the panel (not delegated to the actions hook)
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

  // Panel-UI store actions
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

  // View options store
  const viewOptActions = usePanelViewOptionsStore(
    useShallow((s) => ({
      setViewMode: s.setViewMode,
      loadViewOptions: s.loadViewOptions,
    })),
  );

  // ---------------------------------------------------------------------------
  // Side-effects
  // ---------------------------------------------------------------------------
  useEffect(() => {
    void loadInitial(workspaceId);
  }, [loadInitial, workspaceId]);

  useEffect(() => {
    viewOptActions.loadViewOptions("git", workspaceId);
  }, [viewOptActions.loadViewOptions, workspaceId]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
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
  const capabilities: RepoCapabilities = session?.status?.capabilities ?? DEFAULT_REPO_CAPABILITIES;
  const branchInfo = session?.branchInfo ?? null;
  const hasUpstream = branchInfo?.upstream != null;
  const isBusy = session?.inFlightOp !== null && session?.inFlightOp !== undefined;
  const isRefreshing = session?.inFlightOp?.kind === "refresh" || Boolean(session?.statusFetching);
  const isLoading = !session || session.repoInfo.kind === "detecting" || session.statusFetching;
  const showSkeleton = useLoaderDelay(isLoading ? "running" : "done");
  const draft = session?.commitDraft ?? "";
  const trimmedDraft = draft.trim();
  const operationState = session?.status?.operationState ?? { kind: "none" as const };
  const activeOperation = operationState.kind === "none" ? null : operationState;
  const hasActiveOperation = activeOperation !== null;
  const actionState = useMemo(
    () =>
      selectGitActionButton({
        repoKind: session?.repoInfo.kind ?? "detecting",
        capabilities,
        branch: branchInfo,
        dirty: {
          staged: session?.status?.staged.length ?? 0,
          working: session?.status?.working.length ?? 0,
          untracked: session?.status?.untracked.length ?? 0,
          merge: session?.status?.merge.length ?? 0,
        },
        commitDraft: draft,
      }),
    [branchInfo, capabilities, draft, session?.repoInfo.kind, session?.status],
  );
  const commitActionEnabled =
    (actionState.kind === "commit" || actionState.kind === "make-initial-commit") &&
    !actionState.disabled;
  const commitOptions = session?.commitOptions ?? DEFAULT_GIT_PANEL_STATE.commitOptions;
  const repoPath = session?.repoInfo.kind === "repo" ? session.repoInfo.topLevel : undefined;
  const currentBranchName = branchInfo?.current ?? null;
  const hasRemote = capabilities.remotes.length > 0;

  // ---------------------------------------------------------------------------
  // Dialog + picker state
  // ---------------------------------------------------------------------------
  const dialogs = useGitDialogs();
  const {
    setAddRemoteOpen,
    setEmptyCommitRequest,
    contextBanner,
    setContextBanner,
  } = dialogs;

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

  // ---------------------------------------------------------------------------
  // Actions hook
  // ---------------------------------------------------------------------------
  const actions = useGitPanelActions({
    workspaceId,
    dialogs,
    pickers,
    derived: {
      trimmedDraft,
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
    handleSync,
    requestDiscard,
    requestRemoveRemote,
    requestStashGroup,
    revealTagInHistory,
    runPushGuardAction,
    runPrimaryAction,
    onCreateBranch,
  } = actions;

  // ---------------------------------------------------------------------------
  // Entry actions (per-row context-menu handlers)
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Picker sources
  // ---------------------------------------------------------------------------
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
        title: "Pick from another branch",
        placeholder: "Select a branch to list commits…",
        listBranches: directOps.listBranches,
        acceptTarget: (targetRef) => {
          setCommitPickerRef(targetRef);
          setCommitPickerOpen(true);
        },
      }),
    [currentBranchName, directOps.listBranches, workspaceId, setCommitPickerRef, setCommitPickerOpen],
  );
  const addRemoteFields = useMemo<FormDialogField[]>(
    () => [
      { name: "name", label: "Name", placeholder: "origin" },
      {
        name: "url",
        label: "URL",
        placeholder: "https://github.com/org/repo.git",
        validate: validateGitRemoteUrl,
      },
    ],
    [],
  );

  // ---------------------------------------------------------------------------
  // Error / push-guard banners
  // ---------------------------------------------------------------------------
  const errorAction = buildErrorAction(session?.lastError, {
    workspaceId,
    cwd: repoPath ?? workspaceRootPath,
    onRetry: () => {
      void directOps.refresh(workspaceId);
    },
  });
  const pushGuardBanner = buildPushGuardBannerView({
    error: session?.lastError,
    pendingNonFFRetry: session?.pendingNonFFRetry,
    inFlightKind: session?.inFlightOp?.kind ?? null,
  });

  // ---------------------------------------------------------------------------
  // Hotkey
  // ---------------------------------------------------------------------------
  const handlePanelKeyDown = useGitOpHotkey({
    disabled: isBusy || hasActiveOperation || !commitActionEnabled,
    onCommit: () => {
      void handleCommitStaged();
    },
  });

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  const headerDisabled = isBusy || isLoading;
  const isRepo = session?.repoInfo.kind === "repo";
  const { viewMode } = viewOptions;
  const panelSegment = session?.panelSegment ?? DEFAULT_GIT_PANEL_STATE.panelSegment;
  const historyRef = session?.historyRef ?? DEFAULT_GIT_PANEL_STATE.historyRef;
  const menuEnablement = {
    canCommitStaged: trimmedDraft.length > 0 && hasStagedChanges,
    canCommitAll: trimmedDraft.length > 0 && (hasStagedChanges || stageablePaths.length > 0),
    canCommitAndPush: trimmedDraft.length > 0 && hasStagedChanges && hasRemote,
    canPush: hasRemote && capabilities.hasHEAD,
    canPull: hasRemote,
  };

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label="Source Control"
      onKeyDown={handlePanelKeyDown}
    >
      <GitHeader
        disabled={headerDisabled}
        refreshing={isRefreshing}
        canInit={session?.repoInfo.kind === "non-repo"}
        hasChanges={hasChanges}
        capabilities={capabilities}
        showViewToggle={isRepo}
        viewMode={viewMode}
        onViewModeChange={(next) => viewOptActions.setViewMode("git", workspaceId, next)}
        onExpandAllTrees={() => panelUiOps.expandAllTrees(workspaceId)}
        onCollapseAllTrees={() => panelUiOps.collapseAllTrees(workspaceId)}
        onRefresh={() => {
          void directOps.refresh(workspaceId);
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
        model={buildGitBannerModel({
          pushGuardBanner,
          onPushGuardAction: runPushGuardAction,
          lastError: session?.lastError ?? null,
          errorAction,
          autofetchPaused: session?.autofetchPausedBannerVisible ?? false,
          autofetchLastErrorMessage: session?.autofetchLastError?.message,
          onResumeAutofetch: () => {
            void panelUiOps.resumeAutofetch(workspaceId);
          },
          helperPromptOccupancyMessage: helperPromptOccupancyMessage ?? null,
          contextBanner,
        })}
      />

      {isLoading ? (
        <div className="min-h-0 flex-1">
          {showSkeleton ? (
            <Skeleton label="Loading source control">
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
      ) : session?.repoInfo.kind === "non-repo" ? (
        <EmptyState
          title="Not a Git Repository"
          description="Initialize this workspace to start tracking changes."
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
          lastError={session?.lastError}
          inFlightKind={session?.inFlightOp?.kind}
          onContinueOp={() => {
            void directOps.continueOp(workspaceId);
          }}
          onAbortOp={() => {
            void directOps.abortOp(workspaceId);
          }}
          draft={draft}
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
              title: "Commit empty changes?",
              description: "Create an empty commit without changing the working tree.",
              label: "Message",
              placeholder: "Empty commit message",
              defaultValue: trimmedDraft,
              confirmLabel: "Commit Empty",
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
          onToggleGroup={(key) =>
            panelUiOps.setExpandedGroup(workspaceId, key, !(session?.expandedGroups[key] ?? false))
          }
          onToggleTreeNode={(key, relPath) =>
            panelUiOps.toggleExpandedTreeNode(workspaceId, key, relPath)
          }
          onStagePaths={(paths) => {
            void directOps.stage(workspaceId, paths);
          }}
          onUnstagePaths={(paths) => {
            void directOps.unstage(workspaceId, paths);
          }}
          onDiscardPaths={requestDiscard}
          onMarkResolved={(entry) => {
            void directOps.markResolved(workspaceId, [entry.relPath]);
          }}
          onOpenDiff={(entry, groupKey) => {
            openChanges(entry, groupKey);
          }}
          onOpenFile={openWorkingTreeFile}
          onRevealInOS={revealEntryInOS}
          onCopyPath={copyEntryPath}
          onCopyRelativePath={copyEntryRelativePath}
          onAddToGitignore={addEntryToGitignore}
          onAddPathsToGitignore={(paths) => {
            void addPathsToGitignore(paths);
          }}
          onStashGroup={requestStashGroup}
          branchInfo={branchInfo}
          repoPath={repoPath}
          capabilities={capabilities}
          autofetchIntervalMin={
            session?.autofetchIntervalMin ?? DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin
          }
          autofetchFetching={session?.autofetchFetching ?? false}
          autofetchFailed={
            session?.autofetchLastError !== null && session?.autofetchLastError !== undefined
          }
          onSync={() => {
            void handleSync();
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
          onPublish={() => {
            void requestPush();
          }}
          onSetAutofetchInterval={(intervalMin) => {
            void panelUiOps.setAutofetchInterval(workspaceId, intervalMin);
          }}
          onSwitchBranch={() => openBranchPicker("switch")}
          onCreateFromRef={() => setBranchCreateFromPickerOpen(true)}
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
