/**
 * GitPanel is the top-level Source Control surface for one workspace.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitExpandedGroupKey, GitStatusEntry } from "../../../../shared/types/git";
import { openTerminal } from "../../../services/terminal";
import type { GitStoreError } from "../../../state/stores/git";
import { useGitStore } from "../../../state/stores/git";
import { useLoaderDelay } from "../search/useLoaderDelay";
import { BranchPicker } from "./BranchPicker";
import { ConfirmDiscardDialog, type DiscardConfirmRequest } from "./confirmDiscardDialog";
import { GitBranchBar } from "./GitBranchBar";
import { GitCommitInput } from "./GitCommitInput";
import { GitEmptyState } from "./GitEmptyState";
import { GitGroup } from "./GitGroup";
import { GitHeader } from "./GitHeader";
import { GitInlineBanner } from "./GitInlineBanner";
import { GitLoadingSkeleton } from "./GitLoadingSkeleton";
import { buildGitGroups, collectGitEntryPaths } from "./git-status-utils";
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
   * Isolated integration seam for task 20. When openDiffTab lands, FilesPanel
   * can pass a handler without changing row rendering or git operations.
   */
  onOpenDiff?: (input: GitPanelOpenDiffInput) => void;
}

export function GitPanel({ workspaceId, workspaceRootPath, onOpenDiff }: GitPanelProps) {
  const session = useGitSession(workspaceId);
  const loadInitial = useGitStore((state) => state.loadInitial);
  const refresh = useGitStore((state) => state.refresh);
  const init = useGitStore((state) => state.init);
  const stage = useGitStore((state) => state.stage);
  const unstage = useGitStore((state) => state.unstage);
  const discard = useGitStore((state) => state.discard);
  const commit = useGitStore((state) => state.commit);
  const fetch = useGitStore((state) => state.fetch);
  const pull = useGitStore((state) => state.pull);
  const push = useGitStore((state) => state.push);
  const stash = useGitStore((state) => state.stash);
  const stashPop = useGitStore((state) => state.stashPop);
  const setCommitDraft = useGitStore((state) => state.setCommitDraft);
  const flushCommitDraft = useGitStore((state) => state.flushCommitDraft);
  const setExpandedGroup = useGitStore((state) => state.setExpandedGroup);
  const setViewMode = useGitStore((state) => state.setViewMode);
  const setCompactFolders = useGitStore((state) => state.setCompactFolders);
  const toggleExpandedTreeNode = useGitStore((state) => state.toggleExpandedTreeNode);

  const [discardRequest, setDiscardRequest] = useState<DiscardConfirmRequest | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);

  useEffect(() => {
    void loadInitial(workspaceId);
  }, [loadInitial, workspaceId]);

  const groups = useMemo(() => buildGitGroups(session?.status), [session?.status]);
  const allChangedPaths = useMemo(
    () => collectGitEntryPaths(groups.flatMap((group) => group.entries)),
    [groups],
  );
  const hasChanges = allChangedPaths.length > 0;
  const hasStagedChanges = (session?.status?.staged.length ?? 0) > 0;
  const isBusy = session?.inFlightOp !== null && session?.inFlightOp !== undefined;
  const isCommitting = session?.inFlightOp?.kind === "commit";
  const isRefreshing = session?.inFlightOp?.kind === "refresh" || Boolean(session?.statusFetching);
  const isLoading = !session || session.repoInfo.kind === "detecting" || session.statusFetching;
  const showSkeleton = useLoaderDelay(isLoading ? "running" : "done");
  const draft = session?.commitDraft ?? "";
  const trimmedDraft = draft.trim();
  const commitDisabled = isBusy || trimmedDraft.length === 0 || !hasStagedChanges;
  const repoPath = session?.repoInfo.kind === "repo" ? session.repoInfo.topLevel : undefined;
  const errorAction = buildErrorAction(session?.lastError, {
    workspaceId,
    cwd: repoPath ?? workspaceRootPath,
    onRetry: () => {
      void refresh(workspaceId);
    },
  });

  const handleCommit = useCallback(
    async (options?: { amend?: boolean; pushAfter?: boolean }) => {
      if (commitDisabled) return;
      const result = await commit(workspaceId, { message: trimmedDraft, amend: options?.amend });
      if (result && options?.pushAfter) {
        await push(workspaceId);
      }
    },
    [commit, commitDisabled, push, trimmedDraft, workspaceId],
  );

  const handlePanelKeyDown = useGitOpHotkey({
    disabled: commitDisabled,
    onCommit: () => {
      void handleCommit();
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

  async function handleSync(): Promise<void> {
    const branch = session?.branchInfo;
    if (!branch) return;
    if (branch.behind > 0) await pull(workspaceId);
    if (branch.ahead > 0) await push(workspaceId);
  }

  const headerDisabled = isBusy || isLoading;
  const isRepo = session?.repoInfo.kind === "repo";
  const viewMode = session?.viewMode ?? "tree";
  const compactFolders = session?.compactFolders ?? false;

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
          void fetch(workspaceId);
        }}
        onPull={() => {
          void pull(workspaceId);
        }}
        onPush={() => {
          void push(workspaceId);
        }}
        onStash={() => {
          void stash(workspaceId);
        }}
        onStashPop={() => {
          void stashPop(workspaceId);
        }}
        onSwitchBranch={() => setBranchPickerOpen(true)}
        onDiscardAll={() => requestDiscard(allChangedPaths, "this repository")}
      />

      {session?.lastError ? (
        <GitInlineBanner
          variant="error"
          message={session.lastError.message}
          details={session.lastError.details}
          actionLabel={errorAction.label}
          onAction={errorAction.onAction}
        />
      ) : null}

      {isLoading ? (
        <div className="min-h-0 flex-1">{showSkeleton ? <GitLoadingSkeleton /> : null}</div>
      ) : session?.repoInfo.kind === "non-repo" ? (
        <GitEmptyState
          title="Not a Git Repository"
          description="Initialize this workspace to start tracking changes."
          actionLabel="Initialize Repository"
          disabled={isBusy}
          onAction={() => {
            void init(workspaceId);
          }}
        />
      ) : (
        <>
          <GitCommitInput
            value={draft}
            disabled={isBusy}
            commitDisabled={commitDisabled}
            busy={isCommitting}
            hint={commitHint(trimmedDraft, hasStagedChanges)}
            onChange={(value) => setCommitDraft(workspaceId, value)}
            onBlur={() => flushCommitDraft(workspaceId)}
            onCommit={() => {
              void handleCommit();
            }}
            onAmend={() => {
              void handleCommit({ amend: true });
            }}
            onCommitAndPush={() => {
              void handleCommit({ pushAfter: true });
            }}
            onCommitStaged={() => {
              void handleCommit();
            }}
          />
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
                  onOpenDiff={(entry, groupKey) => {
                    onOpenDiff?.({ workspaceId, groupKey, entry });
                  }}
                />
              ))
            )}
          </div>
          <GitBranchBar
            branch={session.branchInfo}
            repoPath={repoPath}
            disabled={isBusy}
            onSync={() => {
              void handleSync();
            }}
            onSwitchBranch={() => setBranchPickerOpen(true)}
          />
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

      <BranchPicker
        workspaceId={workspaceId}
        open={branchPickerOpen}
        onClose={() => setBranchPickerOpen(false)}
      />
    </fieldset>
  );
}

function commitHint(message: string, hasStagedChanges: boolean): string | undefined {
  if (!message) return "Enter a commit message.";
  if (!hasStagedChanges) return "Stage changes before committing.";
  return undefined;
}

/**
 * Authentication failures need a terminal escape hatch because v1 does not
 * implement askpass. Other failures keep the local retry affordance.
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
  if (error.kind === "auth") return true;
  return /authentication failed|could not read username|could not read password|permission denied|terminal prompts disabled/i.test(
    `${error.message}\n${error.details ?? ""}`,
  );
}
