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
import { useCallback, useEffect, useMemo, useRef } from "react";
import { validateGitRemoteUrl } from "../../../../../shared/git/remote-validation";
import {
  DEFAULT_GIT_PANEL_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitExpandedGroupKey,
  type GitMergeMode,
  type GitStatusEntry,
  type RepoCapabilities,
  type Tag,
} from "../../../../../shared/git/types";
import { selectGitActionButton } from "../../../../state/selectors/git-action-button";
import type { GitPushOptions } from "../../../../state/stores/git";
import { useGitStore } from "../../../../state/stores/git";
import type { FormDialogField } from "../../../ui/form-dialog";
import { submitBranchCreate } from "../branch/create-dialog";
import type { BranchPickerMode } from "../branch/picker";
import { createCommitPickerSource } from "../commit/picker-source";
import { buildRemoteUpstreamWarning } from "../utils/git-more-menu-model";
import {
  buildErrorAction,
  buildPublishBranchPrompt,
  buildTagHistoryRevealMessage,
  tagHistoryRef,
} from "./git-panel-actions";
import { createEntryActions } from "./entry-actions";
import { buildPushGuardBannerView, type PushGuardActionKind } from "../utils/git-push-guard-banner";
import { buildGitBannerModel } from "./git-banner-model";
import { buildGitGroups, collectGitEntryPaths } from "../utils/git-status-utils";
import { buildSquashCommitDraft } from "../pickers/merge-options-dialog";
import { createMergeTargetPickerSource } from "../pickers/merge-target-picker-source";
import { createRebaseTargetPickerSource } from "../pickers/rebase-target-picker-source";
import type { TagPickerMode } from "../pickers/tag-picker-source";
import { useGitPanelPickers } from "../pickers/use-git-panel-pickers";
import { useGitHelperOccupancy } from "../hooks/use-git-helper-prompts";
import { useGitOpHotkey } from "../hooks/use-git-op-hotkey";
import { useGitSession } from "../hooks/use-git-session";
import { useGitDialogs } from "./use-git-dialogs";
import { EmptyState } from "../../../ui/empty-state";
import { Skeleton, SkeletonLine } from "../../../ui/skeleton";
import { GitBannerStack } from "./git-banner-stack";
import { GitDialogHost } from "./git-dialog-host";
import { GitHeader } from "./git-header";
import { GitPanelBody } from "./git-panel-body";
import { useLoaderDelay } from "../../search/useLoaderDelay";

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
  const loadInitial = useGitStore((state) => state.loadInitial);
  const refresh = useGitStore((state) => state.refresh);
  const init = useGitStore((state) => state.init);
  const stage = useGitStore((state) => state.stage);
  const unstage = useGitStore((state) => state.unstage);
  const discard = useGitStore((state) => state.discard);
  const commit = useGitStore((state) => state.commit);
  const commitAmend = useGitStore((state) => state.commitAmend);
  const commitEmpty = useGitStore((state) => state.commitEmpty);
  const createBranch = useGitStore((state) => state.createBranch);
  const addRemote = useGitStore((state) => state.addRemote);
  const removeRemote = useGitStore((state) => state.removeRemote);
  const undoLastCommit = useGitStore((state) => state.undoLastCommit);
  const fetchAll = useGitStore((state) => state.fetchAll);
  const pull = useGitStore((state) => state.pull);
  const push = useGitStore((state) => state.push);
  const pushTags = useGitStore((state) => state.pushTags);
  const sync = useGitStore((state) => state.sync);
  const stash = useGitStore((state) => state.stash);
  const stashPop = useGitStore((state) => state.stashPop);
  const stashGroup = useGitStore((state) => state.stashGroup);
  const merge = useGitStore((state) => state.merge);
  const rebase = useGitStore((state) => state.rebase);
  const cherryPick = useGitStore((state) => state.cherryPick);
  const continueOp = useGitStore((state) => state.continueOp);
  const abortOp = useGitStore((state) => state.abortOp);
  const markResolved = useGitStore((state) => state.markResolved);
  const listBranches = useGitStore((state) => state.listBranches);
  const listRecentCommits = useGitStore((state) => state.listRecentCommits);
  const setCommitDraft = useGitStore((state) => state.setCommitDraft);
  const flushCommitDraft = useGitStore((state) => state.flushCommitDraft);
  const setCommitOption = useGitStore((state) => state.setCommitOption);
  const setAutofetchInterval = useGitStore((state) => state.setAutofetchInterval);
  const resumeAutofetch = useGitStore((state) => state.resumeAutofetch);
  const setPanelSegment = useGitStore((state) => state.setPanelSegment);
  const setHistoryRef = useGitStore((state) => state.setHistoryRef);
  const setExpandedGroup = useGitStore((state) => state.setExpandedGroup);
  const setViewMode = useGitStore((state) => state.setViewMode);
  const setCompactFolders = useGitStore((state) => state.setCompactFolders);
  const clearPendingNonFFRetry = useGitStore((state) => state.clearPendingNonFFRetry);
  const toggleExpandedTreeNode = useGitStore((state) => state.toggleExpandedTreeNode);

  const dialogs = useGitDialogs();
  const {
    setDiscardRequest,
    setBranchCreateRequest,
    setBranchCreateBranchList,
    setBranchCreateBranchListLoading,
    mergeOptionsRequest,
    setMergeOptionsRequest,
    setPublishRequest,
    setEmptyCommitRequest,
    setStashGroupRequest,
    setAddRemoteOpen,
    setRemoveRemoteRequest,
    setForcePushRequest,
    contextBanner,
    setContextBanner,
  } = dialogs;

  const pickers = useGitPanelPickers();
  const {
    setBranchPickerMode,
    setBranchPickerOpen,
    setMergeTargetPickerOpen,
    setRebaseTargetPickerOpen,
    commitPickerRef,
    setCommitPickerRef,
    setCommitPickerOpen,
    setCommitBranchPickerOpen,
    setBranchCreateFromPickerOpen,
    setStashPickerMode,
    setStashPickerOpen,
    setTagPickerMode,
    setTagPickerRemote,
    setTagPickerOpen,
  } = pickers;

  // branchCreateLoadIdRef stays in the container (race guard — per constraint)
  const branchCreateLoadIdRef = useRef(0);

  useEffect(() => {
    void loadInitial(workspaceId);
  }, [loadInitial, workspaceId]);

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
  const errorAction = buildErrorAction(session?.lastError, {
    workspaceId,
    cwd: repoPath ?? workspaceRootPath,
    onRetry: () => {
      void refresh(workspaceId);
    },
  });
  const pushGuardBanner = buildPushGuardBannerView({
    error: session?.lastError,
    pendingNonFFRetry: session?.pendingNonFFRetry,
    inFlightKind: session?.inFlightOp?.kind ?? null,
  });
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
  const currentBranchName = branchInfo?.current ?? null;
  const mergeTargetSource = useMemo(
    () =>
      createMergeTargetPickerSource({
        workspaceId,
        currentBranch: currentBranchName,
        listBranches,
        acceptTarget: (targetRef) => {
          setMergeOptionsRequest({ targetRef });
        },
      }),
    [currentBranchName, listBranches, setMergeOptionsRequest, workspaceId],
  );
  const rebaseTargetSource = useMemo(
    () =>
      createRebaseTargetPickerSource({
        workspaceId,
        currentBranch: currentBranchName,
        listBranches,
        acceptTarget: (targetRef) => {
          void rebase(workspaceId, targetRef);
        },
      }),
    [currentBranchName, listBranches, rebase, workspaceId],
  );
  const commitPickerSource = useMemo(
    () =>
      createCommitPickerSource({
        workspaceId,
        currentBranch: currentBranchName,
        ref: commitPickerRef,
        listRecentCommits,
        acceptCommit: (sha) => {
          void cherryPick(workspaceId, sha);
        },
        requestBranch: () => {
          setCommitBranchPickerOpen(true);
        },
      }),
    [
      cherryPick,
      commitPickerRef,
      currentBranchName,
      listRecentCommits,
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
        listBranches,
        acceptTarget: (targetRef) => {
          setCommitPickerRef(targetRef);
          setCommitPickerOpen(true);
        },
      }),
    [currentBranchName, listBranches, workspaceId, setCommitPickerRef, setCommitPickerOpen],
  );

  /**
   * Opens the create-branch input and refreshes the branch list used for
   * duplicate-name validation. Stale loads are ignored when the dialog closes.
   */
  const openBranchCreateDialog = useCallback(
    (fromRef?: string) => {
      const loadId = branchCreateLoadIdRef.current + 1;
      branchCreateLoadIdRef.current = loadId;
      setBranchCreateRequest(fromRef ? { fromRef } : {});
      setBranchCreateBranchList(null);
      setBranchCreateBranchListLoading(true);

      void listBranches(workspaceId)
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
      listBranches,
      setBranchCreateBranchList,
      setBranchCreateBranchListLoading,
      setBranchCreateRequest,
      workspaceId,
    ],
  );

  /**
   * Closes the create-branch dialog and invalidates any in-flight validation
   * list load that was started for it.
   */
  const closeBranchCreateDialog = useCallback(() => {
    branchCreateLoadIdRef.current += 1;
    setBranchCreateRequest(null);
    setBranchCreateBranchListLoading(false);
  }, [setBranchCreateBranchListLoading, setBranchCreateRequest]);

  /** Opens the shared branch picker with the menu-selected branch action mode. */
  function openBranchPicker(mode: BranchPickerMode): void {
    setBranchPickerMode(mode);
    setBranchPickerOpen(true);
  }

  /** Opens the shared tag picker with the menu-selected tag action mode. */
  function openTagPicker(mode: TagPickerMode, remote?: string): void {
    setTagPickerMode(mode);
    setTagPickerRemote(mode === "delete-remote" ? (remote ?? null) : null);
    setTagPickerOpen(true);
  }

  /**
   * Issues a push, intercepting branches without an upstream so the user
   * sees a "Publish '<branch>' to '<remote>'?" prompt instead of the raw
   * "fatal: No configured push destination" stderr. The prompt dispatches
   * back through the same store action with `publish: true`, which the
   * main process expands to `git push -u <first remote> <branch>`.
   */
  const requestPush = useCallback(
    async (options: GitPushOptions = {}) => {
      if (options.force) {
        setForcePushRequest(options);
        return;
      }
      if (
        !options.publish &&
        !hasUpstream &&
        capabilities.remotes.length > 0 &&
        capabilities.hasHEAD &&
        branchInfo?.current
      ) {
        const prompt = buildPublishBranchPrompt(branchInfo.current, capabilities.remotes);
        if (prompt) setPublishRequest(prompt);
        return;
      }
      await push(workspaceId, options);
    },
    [
      branchInfo?.current,
      capabilities.hasHEAD,
      capabilities.remotes,
      hasUpstream,
      push,
      setForcePushRequest,
      setPublishRequest,
      workspaceId,
    ],
  );

  /**
   * Runs the selected merge mode. Successful squash merges leave staged
   * changes without MERGE_HEAD, so seed the regular commit draft immediately.
   * Stays in thin container — accesses setCommitDraft (per constraint).
   */
  async function confirmMergeOption(mode: GitMergeMode): Promise<void> {
    const request = mergeOptionsRequest;
    setMergeOptionsRequest(null);
    if (!request) return;

    const squashCommits =
      mode === "squash"
        ? ((await listRecentCommits(workspaceId, undefined, request.targetRef)) ?? [])
        : [];
    const result = await merge(workspaceId, request.targetRef, mode);
    if (mode === "squash" && result?.result === "clean") {
      setCommitDraft(workspaceId, buildSquashCommitDraft(request.targetRef, squashCommits));
    }
  }

  const handleCommitStaged = useCallback(async () => {
    if (trimmedDraft.length === 0 || !hasStagedChanges) return;
    await commit(workspaceId, { message: trimmedDraft });
  }, [commit, hasStagedChanges, trimmedDraft, workspaceId]);

  const handleCommitAll = useCallback(async () => {
    if (trimmedDraft.length === 0) return;
    if (stageablePaths.length > 0) await stage(workspaceId, stageablePaths);
    await commit(workspaceId, { message: trimmedDraft });
  }, [commit, stage, stageablePaths, trimmedDraft, workspaceId]);

  const handleAmend = useCallback(async () => {
    await commitAmend(workspaceId, { message: trimmedDraft });
  }, [commitAmend, trimmedDraft, workspaceId]);

  const handleCommitAndPush = useCallback(async () => {
    if (trimmedDraft.length === 0 || !hasStagedChanges) return;
    const result = await commit(workspaceId, { message: trimmedDraft });
    if (result) await requestPush();
  }, [commit, hasStagedChanges, requestPush, trimmedDraft, workspaceId]);

  const handlePanelKeyDown = useGitOpHotkey({
    disabled: isBusy || hasActiveOperation || !commitActionEnabled,
    onCommit: () => {
      void handleCommitStaged();
    },
  });

  function requestDiscard(
    paths: string[],
    description: string,
    source?: GitExpandedGroupKey,
  ): void {
    if (paths.length === 0) return;
    const count = paths.length;
    setDiscardRequest({
      relPaths: paths,
      ...(source ? { source } : {}),
      title: count === 1 ? "Discard changes?" : `Discard ${count} changes?`,
      description:
        count === 1
          ? `Discard changes in ${description}? This cannot be undone.`
          : `Discard all changes in ${description}? This cannot be undone.`,
    });
  }

  /**
   * Opens the destructive confirmation for removing a configured remote.
   */
  function requestRemoveRemote(remote: string): void {
    const upstreamWarning = buildRemoteUpstreamWarning(branchInfo, remote);
    const baseDescription = `Remote '${remote}' will be removed from this repository.`;
    setRemoveRemoteRequest({
      remote,
      confirm: {
        relPaths: [remote],
        title: `Remove remote '${remote}'?`,
        description: upstreamWarning ? `${upstreamWarning} ${baseDescription}` : baseDescription,
        confirmLabel: "Remove",
      },
    });
  }

  async function handleSync(): Promise<void> {
    const result = await sync(workspaceId);
    if (result?.pulled === "cancelled") {
      setContextBanner({ variant: "info", message: "Sync cancelled (pull aborted before push)." });
    }
  }

  /** Dispatches one of the typed push guardrail banner actions. */
  function runPushGuardAction(kind: PushGuardActionKind): void {
    switch (kind) {
      case "pull":
        void pull(workspaceId);
        break;
      case "force":
        void requestPush({
          ...(session?.pendingNonFFRetry?.originalPushOpts ?? {}),
          force: true,
        });
        break;
      case "cancel":
        clearPendingNonFFRetry(workspaceId);
        break;
      case "retry":
        if (session?.pendingNonFFRetry) {
          void push(workspaceId, session.pendingNonFFRetry.originalPushOpts);
        }
        break;
      case "fetch":
        void fetchAll(workspaceId);
        break;
    }
  }

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

  /** Dispatches the selector-chosen primary Source Control action. */
  function runPrimaryAction(): void {
    switch (actionState.kind) {
      case "initialize-repository":
        void init(workspaceId);
        break;
      case "make-initial-commit":
      case "commit":
        void handleCommitStaged();
        break;
      case "stage-all":
        void stage(workspaceId, stageablePaths);
        break;
      case "sync":
        void handleSync();
        break;
      case "push":
      case "publish-branch":
        void requestPush();
        break;
      case "pull":
        void pull(workspaceId);
        break;
      case "commit-disabled":
      case "no-remote":
      case "up-to-date":
        break;
    }
  }

  /**
   * Opens the group-stash prompt with an optional message field.
   */
  function requestStashGroup(paths: string[], label: string): void {
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
  }

  /**
   * Retargets the shipped History panel to the selected tag ref.
   */
  function revealTagInHistory(tag: Tag): void {
    const ref = tagHistoryRef(tag);
    setHistoryRef(workspaceId, ref);
    setPanelSegment(workspaceId, "history");
    setTagPickerOpen(false);
    setContextBanner({
      variant: "info",
      message: buildTagHistoryRevealMessage(tag),
    });
  }

  const headerDisabled = isBusy || isLoading;
  const isRepo = session?.repoInfo.kind === "repo";
  const viewMode = session?.viewMode ?? "tree";
  const compactFolders = session?.compactFolders ?? false;
  const panelSegment = session?.panelSegment ?? DEFAULT_GIT_PANEL_STATE.panelSegment;
  const historyRef = session?.historyRef ?? DEFAULT_GIT_PANEL_STATE.historyRef;
  const hasRemote = capabilities.remotes.length > 0;
  const menuEnablement = {
    canCommitStaged: trimmedDraft.length > 0 && hasStagedChanges,
    canCommitAll: trimmedDraft.length > 0 && (hasStagedChanges || stageablePaths.length > 0),
    canCommitAndPush: trimmedDraft.length > 0 && hasStagedChanges && hasRemote,
    canPush: hasRemote && capabilities.hasHEAD,
    canPull: hasRemote,
  };

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
        compactFolders={compactFolders}
        onViewModeChange={(next) => setViewMode(workspaceId, next)}
        onCompactFoldersChange={(next) => setCompactFolders(workspaceId, next)}
        onRefresh={() => {
          void refresh(workspaceId);
        }}
        onInit={() => {
          void init(workspaceId);
        }}
        onFetch={() => {
          void fetchAll(workspaceId);
        }}
        onPull={() => {
          void pull(workspaceId);
        }}
        onPush={() => {
          void requestPush();
        }}
        onStash={() => {
          void stash(workspaceId);
        }}
        onStashPop={() => {
          void stashPop(workspaceId);
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
          void pushTags(workspaceId, remote);
        }}
        onAddRemote={() => setAddRemoteOpen(true)}
        onRemoveRemote={requestRemoveRemote}
        onDiscardAll={() => requestDiscard(allChangedPaths, "this repository")}
        autofetchIntervalMin={
          session?.autofetchIntervalMin ?? DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin
        }
        lastFetchedAt={session?.status?.lastFetchedAt ?? null}
        onSetAutofetchInterval={(intervalMin) => {
          void setAutofetchInterval(workspaceId, intervalMin);
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
            void resumeAutofetch(workspaceId);
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
          onSegmentChange={(segment) => setPanelSegment(workspaceId, segment)}
          historyRef={historyRef}
          onHistoryRefChange={(nextRef) => setHistoryRef(workspaceId, nextRef)}
          activeOperation={activeOperation}
          lastError={session?.lastError}
          inFlightKind={session?.inFlightOp?.kind}
          onContinueOp={() => {
            void continueOp(workspaceId);
          }}
          onAbortOp={() => {
            void abortOp(workspaceId);
          }}
          draft={draft}
          actionState={actionState}
          commitOptions={commitOptions}
          menuEnablement={menuEnablement}
          onDraftChange={(value) => setCommitDraft(workspaceId, value)}
          onDraftBlur={() => flushCommitDraft(workspaceId)}
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
            void undoLastCommit(workspaceId);
          }}
          onToggleCommitOption={(option, value) =>
            setCommitOption(workspaceId, option, value)
          }
          onPushOnly={() => {
            void requestPush();
          }}
          onPullOnly={() => {
            void pull(workspaceId);
          }}
          groups={groups}
          viewMode={viewMode}
          compactFolders={compactFolders}
          expandedGroups={session?.expandedGroups ?? {}}
          expandedTreeNodes={session?.expandedTreeNodes ?? {}}
          onToggleGroup={(key) =>
            setExpandedGroup(workspaceId, key, !(session?.expandedGroups[key] ?? false))
          }
          onToggleTreeNode={(key, relPath) => toggleExpandedTreeNode(workspaceId, key, relPath)}
          onStagePaths={(paths) => {
            void stage(workspaceId, paths);
          }}
          onUnstagePaths={(paths) => {
            void unstage(workspaceId, paths);
          }}
          onDiscardPaths={requestDiscard}
          onMarkResolved={(entry) => {
            void markResolved(workspaceId, [entry.relPath]);
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
          autofetchIntervalMin={session?.autofetchIntervalMin ?? DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin}
          autofetchFetching={session?.autofetchFetching ?? false}
          autofetchFailed={session?.autofetchLastError !== null && session?.autofetchLastError !== undefined}
          onSync={() => {
            void handleSync();
          }}
          onFetch={() => {
            void fetchAll(workspaceId);
          }}
          onPull={() => {
            void pull(workspaceId);
          }}
          onPush={() => {
            void requestPush();
          }}
          onPublish={() => {
            void requestPush();
          }}
          onSetAutofetchInterval={(intervalMin) => {
            void setAutofetchInterval(workspaceId, intervalMin);
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
            void discard(workspaceId, relPaths, source);
          },
          onRemoveRemote: (remote) => {
            void removeRemote(workspaceId, remote);
          },
          onForcePush: (options) => {
            void push(workspaceId, options);
          },
          onOpenBranchCreateDialog: openBranchCreateDialog,
          onCloseBranchCreateDialog: closeBranchCreateDialog,
          onCreateBranch: async (_wid, name, fromRef) => {
            await submitBranchCreate({
              workspaceId,
              name,
              fromRef,
              createBranch,
            });
          },
          onConfirmMergeOption: (mode) => {
            void confirmMergeOption(mode);
          },
          onConfirmPublish: () => {
            void push(workspaceId, { publish: true });
          },
          onConfirmEmptyCommit: (value) => {
            void commitEmpty(workspaceId, value);
          },
          onConfirmStashGroup: (paths, message) => {
            void stashGroup(workspaceId, paths, message);
          },
          onConfirmAddRemote: (name, url) => {
            void addRemote(workspaceId, name, url);
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
