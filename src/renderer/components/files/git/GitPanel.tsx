/**
 * GitPanel is the top-level Source Control surface for one workspace.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateGitRemoteUrl } from "../../../../shared/git-remote-validation";
import {
  type BranchList,
  DEFAULT_GIT_PANEL_STATE,
  DEFAULT_REPO_CAPABILITIES,
  type GitExpandedGroupKey,
  type GitMergeMode,
  type GitStatusEntry,
  type RepoCapabilities,
  type Tag,
} from "../../../../shared/types/git";
import { openTerminal } from "../../../services/terminal";
import { selectGitActionButton } from "../../../state/selectors/git-action-button";
import type { GitPushOptions, GitStoreError } from "../../../state/stores/git";
import { useGitStore } from "../../../state/stores/git";
import { FormDialog, type FormDialogField } from "../../ui/form-dialog";
import { CommandPalette } from "../../ui/palette/command-palette";
import { PromptDialog, type PromptRequest } from "../../ui/prompt-dialog";
import { useLoaderDelay } from "../search/useLoaderDelay";
import {
  BranchCreateDialog,
  type BranchCreateRequest,
  submitBranchCreate,
} from "./BranchCreateDialog";
import { BranchPicker, type BranchPickerMode } from "./BranchPicker";
import { type CommitPickItem, createCommitPickerSource } from "./commit-picker-source";
import { ConfirmDiscardDialog, type DiscardConfirmRequest } from "./confirmDiscardDialog";
import { GitBranchBar } from "./GitBranchBar";
import { GitCommitInput } from "./GitCommitInput";
import { GitEmptyState } from "./GitEmptyState";
import { GitGroup } from "./GitGroup";
import { GitHeader } from "./GitHeader";
import { GitInlineBanner } from "./GitInlineBanner";
import { GitLoadingSkeleton } from "./GitLoadingSkeleton";
import { buildRemoteUpstreamWarning } from "./git-more-menu-model";
import {
  buildPublishBranchPrompt,
  buildTagHistoryRevealMessage,
  tagHistoryRef,
} from "./git-panel-actions";
import { createEntryActions } from "./git-panel/entry-actions";
import { buildPushGuardBannerView, type PushGuardActionKind } from "./git-push-guard-banner";
import { buildGitGroups, collectGitEntryPaths } from "./git-status-utils";
import { HistoryPanel } from "./history/HistoryPanel";
import { HistorySegmentToggle } from "./history/HistorySegmentToggle";
import {
  buildSquashCommitDraft,
  MergeOptionsDialog,
  type MergeOptionsRequest,
} from "./MergeOptionsDialog";
import {
  createMergeTargetPickerSource,
  type MergeTargetPickItem,
} from "./merge-target-picker-source";
import { OperationBanner } from "./OperationBanner";
import {
  createRebaseTargetPickerSource,
  type RebaseTargetPickItem,
} from "./rebase-target-picker-source";
import { StashPicker } from "./StashPicker";
import { TagPicker } from "./TagPicker";
import type { TagPickerMode } from "./tag-picker-source";
import { useGitPanelPickers } from "./use-git-panel-pickers";
import { useGitHelperOccupancy } from "./useGitHelperPrompts";
import { useGitOpHotkey } from "./useGitOpHotkey";
import { useGitSession } from "./useGitSession";

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
  const setHistoryScope = useGitStore((state) => state.setHistoryScope);
  const setExpandedGroup = useGitStore((state) => state.setExpandedGroup);
  const setViewMode = useGitStore((state) => state.setViewMode);
  const setCompactFolders = useGitStore((state) => state.setCompactFolders);
  const clearPendingNonFFRetry = useGitStore((state) => state.clearPendingNonFFRetry);
  const toggleExpandedTreeNode = useGitStore((state) => state.toggleExpandedTreeNode);

  const [discardRequest, setDiscardRequest] = useState<DiscardConfirmRequest | null>(null);
  const {
    branchPickerOpen,
    setBranchPickerOpen,
    branchPickerMode,
    setBranchPickerMode,
    mergeTargetPickerOpen,
    setMergeTargetPickerOpen,
    rebaseTargetPickerOpen,
    setRebaseTargetPickerOpen,
    commitPickerOpen,
    setCommitPickerOpen,
    commitBranchPickerOpen,
    setCommitBranchPickerOpen,
    commitPickerRef,
    setCommitPickerRef,
    branchCreateFromPickerOpen,
    setBranchCreateFromPickerOpen,
    stashPickerOpen,
    setStashPickerOpen,
    stashPickerMode,
    setStashPickerMode,
    tagPickerOpen,
    setTagPickerOpen,
    tagPickerMode,
    setTagPickerMode,
    tagPickerRemote,
    setTagPickerRemote,
  } = useGitPanelPickers();
  const [branchCreateRequest, setBranchCreateRequest] = useState<BranchCreateRequest | null>(null);
  const [branchCreateBranchList, setBranchCreateBranchList] = useState<BranchList | null>(null);
  const [branchCreateBranchListLoading, setBranchCreateBranchListLoading] = useState(false);
  const branchCreateLoadIdRef = useRef(0);
  const [mergeOptionsRequest, setMergeOptionsRequest] = useState<MergeOptionsRequest | null>(null);
  const [publishRequest, setPublishRequest] = useState<PromptRequest | null>(null);
  const [emptyCommitRequest, setEmptyCommitRequest] = useState<PromptRequest | null>(null);
  const [stashGroupRequest, setStashGroupRequest] = useState<{
    paths: string[];
    prompt: PromptRequest;
  } | null>(null);
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  const [removeRemoteRequest, setRemoveRemoteRequest] = useState<{
    remote: string;
    confirm: DiscardConfirmRequest;
  } | null>(null);
  const [forcePushRequest, setForcePushRequest] = useState<GitPushOptions | null>(null);
  const [contextBanner, setContextBanner] = useState<{
    variant: "info" | "error";
    message: string;
  } | null>(null);

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
    [currentBranchName, listBranches, workspaceId],
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
    [listBranches, workspaceId],
  );

  /**
   * Closes the create-branch dialog and invalidates any in-flight validation
   * list load that was started for it.
   */
  const closeBranchCreateDialog = useCallback(() => {
    branchCreateLoadIdRef.current += 1;
    setBranchCreateRequest(null);
    setBranchCreateBranchListLoading(false);
  }, []);

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
      workspaceId,
    ],
  );

  /**
   * Runs the selected merge mode. Successful squash merges leave staged
   * changes without MERGE_HEAD, so seed the regular commit draft immediately.
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
    [workspaceId, repoPath, workspaceRootPath, onOpenDiff],
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
    setHistoryScope(workspaceId, "ref");
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
  const historyScope = session?.historyScope ?? DEFAULT_GIT_PANEL_STATE.historyScope;
  const hasRemote = capabilities.remotes.length > 0;
  const menuEnablement = {
    canCommitStaged: trimmedDraft.length > 0 && hasStagedChanges,
    canCommitAll: trimmedDraft.length > 0 && (hasStagedChanges || stageablePaths.length > 0),
    canCommitAndPush: trimmedDraft.length > 0 && hasStagedChanges && hasRemote,
    canPush: hasRemote && capabilities.hasHEAD,
    canPull: hasRemote,
  };

  return (
    <fieldset
      className="flex h-full min-h-0 min-w-0 flex-col border-0"
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

      {branchInfo?.isUnborn ? (
        // Unborn HEAD: `git init` planted a symbolic ref but no commit has
        // landed yet. Without this banner, users perceive `git checkout -b`
        // as deleting their branch when in fact the unborn ref simply gets
        // re-pointed (see git-repository-create-branch.test.ts).
        <GitInlineBanner
          variant="info"
          message={`'${branchInfo.current}' has no commits yet — it will be created on your first commit.`}
        />
      ) : null}
      {pushGuardBanner ? (
        <GitInlineBanner
          variant={pushGuardBanner.variant}
          message={pushGuardBanner.message}
          details={pushGuardBanner.details}
          actions={pushGuardBanner.actions.map((action) => ({
            label: action.label,
            variant:
              action.destructive === true
                ? "destructive"
                : action.kind === "cancel"
                  ? "ghost"
                  : "default",
            onAction: () => runPushGuardAction(action.kind),
          }))}
        />
      ) : session?.lastError ? (
        <GitInlineBanner
          variant="error"
          message={session.lastError.message}
          details={session.lastError.details}
          actionLabel={errorAction.label}
          onAction={errorAction.onAction}
        />
      ) : null}
      {helperPromptOccupancyMessage ? (
        <GitInlineBanner variant="info" message={helperPromptOccupancyMessage} />
      ) : null}
      {session?.autofetchPausedBannerVisible ? (
        <GitInlineBanner
          variant="warning"
          message="Autofetch paused after repeated failures."
          details={session.autofetchLastError?.message}
          actionLabel="Resume"
          onAction={() => {
            void resumeAutofetch(workspaceId);
          }}
        />
      ) : null}
      {contextBanner ? (
        <GitInlineBanner variant={contextBanner.variant} message={contextBanner.message} />
      ) : null}

      {isLoading ? (
        <div className="min-h-0 flex-1">{showSkeleton ? <GitLoadingSkeleton /> : null}</div>
      ) : session?.repoInfo.kind === "non-repo" ? (
        <GitEmptyState
          title="Not a Git Repository"
          description="Initialize this workspace to start tracking changes."
          actionLabel={actionState.label}
          disabled={isBusy}
          onAction={() => {
            runPrimaryAction();
          }}
        />
      ) : (
        <>
          <HistorySegmentToggle
            segment={panelSegment}
            disabled={isBusy}
            onChange={(segment) => setPanelSegment(workspaceId, segment)}
          />
          {panelSegment === "history" ? (
            <HistoryPanel
              workspaceId={workspaceId}
              refName={historyRef}
              historyScope={historyScope}
              busy={isBusy}
              onRefChange={(nextRef) => setHistoryRef(workspaceId, nextRef)}
              onScopeChange={(nextScope) => setHistoryScope(workspaceId, nextScope)}
            />
          ) : (
            <>
              {activeOperation ? (
                <OperationBanner
                  state={activeOperation}
                  error={session.lastError}
                  inFlightKind={session.inFlightOp?.kind}
                  onContinue={() => {
                    void continueOp(workspaceId);
                  }}
                  onAbort={() => {
                    void abortOp(workspaceId);
                  }}
                />
              ) : (
                <GitCommitInput
                  value={draft}
                  disabled={isBusy}
                  busy={isBusy}
                  hint={actionState.hint}
                  action={actionState}
                  commitOptions={commitOptions}
                  menuEnablement={menuEnablement}
                  onChange={(value) => setCommitDraft(workspaceId, value)}
                  onBlur={() => flushCommitDraft(workspaceId)}
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
                />
              )}
              <div className="min-h-0 flex-1 overflow-auto app-scrollbar py-1">
                {groups.length === 0 ? (
                  <GitEmptyState
                    title="No Changes"
                    description="Your working tree has no pending source control changes."
                  />
                ) : (
                  groups.map((group) => (
                    <GitGroup
                      key={group.key}
                      groupKey={group.key}
                      label={group.label}
                      entries={group.entries}
                      expanded={session.expandedGroups[group.key]}
                      viewMode={viewMode}
                      compactFolders={compactFolders}
                      expandedTreeNodes={session.expandedTreeNodes[group.key]}
                      onToggle={() =>
                        setExpandedGroup(workspaceId, group.key, !session.expandedGroups[group.key])
                      }
                      onToggleTreeNode={(relPath) =>
                        toggleExpandedTreeNode(workspaceId, group.key, relPath)
                      }
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
                    />
                  ))
                )}
              </div>
              <GitBranchBar
                workspaceId={workspaceId}
                branch={session.branchInfo}
                repoPath={repoPath}
                disabled={isBusy}
                capabilities={capabilities}
                autofetchIntervalMin={session.autofetchIntervalMin}
                autofetchFetching={session.autofetchFetching}
                autofetchFailed={session.autofetchLastError !== null}
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
            </>
          )}
        </>
      )}

      <ConfirmDiscardDialog
        request={discardRequest}
        busy={session?.inFlightOp?.kind === "discard"}
        onCancel={() => setDiscardRequest(null)}
        onConfirm={(request) => {
          setDiscardRequest(null);
          void discard(workspaceId, request.relPaths, request.source);
        }}
      />
      <ConfirmDiscardDialog
        request={removeRemoteRequest?.confirm ?? null}
        busy={session?.inFlightOp?.kind === "removeRemote"}
        onCancel={() => setRemoveRemoteRequest(null)}
        onConfirm={() => {
          const remote = removeRemoteRequest?.remote;
          setRemoveRemoteRequest(null);
          if (!remote) return;
          void removeRemote(workspaceId, remote);
        }}
      />
      <ConfirmDiscardDialog
        request={
          forcePushRequest
            ? {
                title: "Force push will overwrite remote. Are you sure?",
                description: "Uses --force-with-lease and stops if the remote changed again.",
                relPaths: [],
                confirmLabel: "Force Push",
              }
            : null
        }
        busy={session?.inFlightOp?.kind === "push"}
        onCancel={() => setForcePushRequest(null)}
        onConfirm={() => {
          const options = forcePushRequest;
          setForcePushRequest(null);
          if (!options) return;
          void push(workspaceId, options);
        }}
      />

      <BranchPicker
        workspaceId={workspaceId}
        open={branchPickerOpen}
        mode={branchPickerMode}
        onClose={() => setBranchPickerOpen(false)}
      />

      <CommandPalette<MergeTargetPickItem>
        open={mergeTargetPickerOpen}
        source={mergeTargetSource}
        onClose={() => setMergeTargetPickerOpen(false)}
        footer="Enter choose merge target · Current branch hidden"
      />

      <CommandPalette<RebaseTargetPickItem>
        open={rebaseTargetPickerOpen}
        source={rebaseTargetSource}
        onClose={() => setRebaseTargetPickerOpen(false)}
        footer="Enter choose rebase target · Current branch hidden"
      />

      <CommandPalette<CommitPickItem>
        open={commitPickerOpen}
        source={commitPickerSource}
        onClose={() => setCommitPickerOpen(false)}
        footer="Enter cherry-pick one commit · Multi-pick is not enabled"
      />

      <CommandPalette<MergeTargetPickItem>
        open={commitBranchPickerOpen}
        source={commitBranchSource}
        onClose={() => setCommitBranchPickerOpen(false)}
        footer="Enter choose branch · Current branch hidden"
      />

      <BranchPicker
        workspaceId={workspaceId}
        open={branchCreateFromPickerOpen}
        mode="select-ref"
        title="Create branch from"
        placeholder="Select a branch to create from…"
        onClose={() => setBranchCreateFromPickerOpen(false)}
        onSelectRef={(ref) => {
          setBranchCreateFromPickerOpen(false);
          openBranchCreateDialog(ref);
        }}
        footer="Enter choose start point · Working tree is not changed"
      />

      <StashPicker
        workspaceId={workspaceId}
        open={stashPickerOpen}
        mode={stashPickerMode}
        onClose={() => setStashPickerOpen(false)}
      />

      <TagPicker
        workspaceId={workspaceId}
        open={tagPickerOpen}
        mode={tagPickerMode}
        selectedRemote={tagPickerRemote}
        onClose={() => setTagPickerOpen(false)}
        onRequestReopen={() => setTagPickerOpen(true)}
        onRevealTag={revealTagInHistory}
      />

      <MergeOptionsDialog
        request={mergeOptionsRequest}
        busy={session?.inFlightOp?.kind === "merge"}
        onCancel={() => setMergeOptionsRequest(null)}
        onConfirm={(_option, mode) => {
          void confirmMergeOption(mode);
        }}
      />

      <PromptDialog
        request={publishRequest}
        busy={session?.inFlightOp?.kind === "push"}
        onCancel={() => setPublishRequest(null)}
        onConfirm={() => {
          setPublishRequest(null);
          void push(workspaceId, { publish: true });
        }}
      />
      <PromptDialog
        request={emptyCommitRequest}
        busy={session?.inFlightOp?.kind === "commit"}
        onCancel={() => setEmptyCommitRequest(null)}
        onConfirm={(value) => {
          setEmptyCommitRequest(null);
          void commitEmpty(workspaceId, value);
        }}
      />
      <BranchCreateDialog
        request={branchCreateRequest}
        branchList={branchCreateBranchList}
        loadingExistingBranches={branchCreateBranchListLoading}
        busy={session?.inFlightOp?.kind === "createBranch"}
        onCancel={closeBranchCreateDialog}
        onSubmit={(name) => {
          const request = branchCreateRequest;
          closeBranchCreateDialog();
          if (!request) return;
          void submitBranchCreate({
            workspaceId,
            name,
            fromRef: request.fromRef,
            createBranch,
          });
        }}
      />
      <PromptDialog
        request={stashGroupRequest?.prompt ?? null}
        busy={session?.inFlightOp?.kind === "stashGroup"}
        onCancel={() => setStashGroupRequest(null)}
        onConfirm={(value) => {
          const request = stashGroupRequest;
          setStashGroupRequest(null);
          if (!request) return;
          void stashGroup(workspaceId, request.paths, value);
        }}
      />
      <FormDialog
        open={addRemoteOpen}
        title="Add remote"
        description="Configure a local Git remote. The URL pattern is checked locally without a network probe."
        fields={addRemoteFields}
        submitLabel="Add Remote"
        errorClassName="git-destructive-text"
        busy={session?.inFlightOp?.kind === "addRemote"}
        onCancel={() => setAddRemoteOpen(false)}
        onSubmit={({ values }) => {
          setAddRemoteOpen(false);
          void addRemote(workspaceId, values.name ?? "", values.url ?? "");
        }}
      />
    </fieldset>
  );
}

/**
 * Authentication failures keep a terminal escape hatch for credential helpers
 * that cannot be represented by the askpass dialog. Other failures keep the
 * local retry affordance.
 */
function buildErrorAction(
  error: GitStoreError | null | undefined,
  opts: { workspaceId: string; cwd?: string; onRetry: () => void },
): { label: string; onAction: () => void } {
  const cwd = opts.cwd;
  if (error && isAuthGitError(error) && cwd) {
    return {
      label: "Open Terminal",
      onAction: () => {
        openTerminal({ workspaceId: opts.workspaceId, cwd });
      },
    };
  }

  return { label: "Retry", onAction: opts.onRetry };
}

/**
 * Branches on stable GitError.kind when available, with message fallback for
 * Electron IPC error serialization that can strip custom Error properties.
 */
function isAuthGitError(error: GitStoreError): boolean {
  if (error.kind === "auth" || error.kind === "auth-required") return true;
  return /authentication failed|could not read username|could not read password|permission denied|terminal prompts disabled/i.test(
    `${error.message}\n${error.details ?? ""}`,
  );
}

