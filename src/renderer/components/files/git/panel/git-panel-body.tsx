/**
 * GitPanelBody renders the main content area of the Source Control panel for
 * a detected git repository.
 *
 * Owns: HistorySegmentToggle · HistoryPanel · OperationBanner ·
 *       GitCommitInput · file-group list · GitBranchBar.
 *
 * Owns no state — all values and callbacks come from props.
 */

import type {
  BranchInfo,
  GitAutofetchIntervalMin,
  GitCommitOptions,
  GitExpandedGroupKey,
  GitPanelSegment,
  GitStatusEntry,
  RepoCapabilities,
} from "../../../../../shared/git/types";
import type { ViewMode } from "../../../../../shared/types/panel";
import type { GitActionButtonState } from "../../../../state/selectors/git-action-button";
import type { GitStoreError } from "../../../../state/stores/git";
import { EmptyState } from "../../../ui/empty-state";
import { GitBranchBar } from "../branch/git-branch-bar";
import type { GitCommitMenuEnablement } from "../commit/git-commit-button";
import { GitCommitInput } from "../commit/git-commit-input";
import { GitGroup } from "../file-row/git-group";
import { HistoryPanel } from "../history/panel";
import { HistorySegmentToggle } from "../history/segment-toggle";
import type { GitGroupDescriptor } from "../utils/git-status-utils";
import type { ActiveGitOperationState } from "./operation-banner";
import { OperationBanner } from "./operation-banner";

export interface GitPanelBodyProps {
  workspaceId: string;

  // Segment control
  panelSegment: GitPanelSegment;
  isBusy: boolean;
  onSegmentChange: (segment: GitPanelSegment) => void;

  // History panel (shown when panelSegment === "history")
  historyRef: string;
  onHistoryRefChange: (ref: string) => void;

  // Operation banner / commit input (shown when panelSegment === "changes")
  activeOperation: ActiveGitOperationState | null;
  lastError: GitStoreError | null | undefined;
  inFlightKind: string | null | undefined;
  onContinueOp: () => void;
  onAbortOp: () => void;

  // Commit input props
  draft: string;
  actionState: GitActionButtonState;
  commitOptions: GitCommitOptions;
  menuEnablement: GitCommitMenuEnablement;
  onDraftChange: (value: string) => void;
  onDraftBlur: () => void;
  onPrimaryAction: () => void;
  onCommitStaged: () => void;
  onCommitAll: () => void;
  onAmend: () => void;
  onCommitAndPush: () => void;
  onCommitEmpty: () => void;
  onUndoLastCommit: () => void;
  onToggleCommitOption: <K extends keyof GitCommitOptions>(
    option: K,
    value: GitCommitOptions[K],
  ) => void;
  onPushOnly: () => void;
  onPullOnly: () => void;

  // File group list
  groups: GitGroupDescriptor[];
  viewMode: ViewMode;
  compactFolders: boolean;
  expandedGroups: Record<string, boolean>;
  expandedTreeNodes: Record<string, string[]>;
  onToggleGroup: (key: GitExpandedGroupKey) => void;
  onToggleTreeNode: (key: GitExpandedGroupKey, relPath: string) => void;
  onStagePaths: (paths: string[]) => void;
  onUnstagePaths: (paths: string[]) => void;
  onDiscardPaths: (paths: string[], description: string, source: GitExpandedGroupKey) => void;
  onMarkResolved: (entry: GitStatusEntry) => void;
  onOpenDiff: (entry: GitStatusEntry, groupKey: GitExpandedGroupKey) => void;
  onOpenFile: (entry: GitStatusEntry) => void;
  onRevealInOS: (entry: GitStatusEntry) => void;
  onCopyPath: (entry: GitStatusEntry) => void;
  onCopyRelativePath: (entry: GitStatusEntry) => void;
  onAddToGitignore: (entry: GitStatusEntry) => void;
  onAddPathsToGitignore: (paths: string[]) => void;
  onStashGroup: (paths: string[], label: string) => void;

  // Branch bar
  branchInfo: BranchInfo | null;
  repoPath: string | undefined;
  capabilities: RepoCapabilities;
  autofetchIntervalMin: GitAutofetchIntervalMin;
  autofetchFetching: boolean;
  autofetchFailed: boolean;
  onSync: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onPublish: () => void;
  onSetAutofetchInterval: (intervalMin: GitAutofetchIntervalMin) => void;
  onSwitchBranch: () => void;
  onCreateFromRef: () => void;
}

export function GitPanelBody({
  workspaceId,
  panelSegment,
  isBusy,
  onSegmentChange,
  historyRef,
  onHistoryRefChange,
  activeOperation,
  lastError,
  inFlightKind,
  onContinueOp,
  onAbortOp,
  draft,
  actionState,
  commitOptions,
  menuEnablement,
  onDraftChange,
  onDraftBlur,
  onPrimaryAction,
  onCommitStaged,
  onCommitAll,
  onAmend,
  onCommitAndPush,
  onCommitEmpty,
  onUndoLastCommit,
  onToggleCommitOption,
  onPushOnly,
  onPullOnly,
  groups,
  viewMode,
  compactFolders,
  expandedGroups,
  expandedTreeNodes,
  onToggleGroup,
  onToggleTreeNode,
  onStagePaths,
  onUnstagePaths,
  onDiscardPaths,
  onMarkResolved,
  onOpenDiff,
  onOpenFile,
  onRevealInOS,
  onCopyPath,
  onCopyRelativePath,
  onAddToGitignore,
  onAddPathsToGitignore,
  onStashGroup,
  branchInfo,
  repoPath,
  capabilities,
  autofetchIntervalMin,
  autofetchFetching,
  autofetchFailed,
  onSync,
  onFetch,
  onPull,
  onPush,
  onPublish,
  onSetAutofetchInterval,
  onSwitchBranch,
  onCreateFromRef,
}: GitPanelBodyProps) {
  return (
    <>
      <HistorySegmentToggle segment={panelSegment} disabled={isBusy} onChange={onSegmentChange} />
      {panelSegment === "history" ? (
        <HistoryPanel
          workspaceId={workspaceId}
          refName={historyRef}
          busy={isBusy}
          onRefChange={onHistoryRefChange}
        />
      ) : (
        <>
          {activeOperation ? (
            <OperationBanner
              state={activeOperation}
              error={lastError}
              inFlightKind={inFlightKind}
              onContinue={onContinueOp}
              onAbort={onAbortOp}
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
              onChange={onDraftChange}
              onBlur={onDraftBlur}
              onPrimaryAction={onPrimaryAction}
              onCommitStaged={onCommitStaged}
              onCommitAll={onCommitAll}
              onAmend={onAmend}
              onCommitAndPush={onCommitAndPush}
              onCommitEmpty={onCommitEmpty}
              onUndoLastCommit={onUndoLastCommit}
              onToggleCommitOption={onToggleCommitOption}
              onPushOnly={onPushOnly}
              onPullOnly={onPullOnly}
            />
          )}
          <div className="min-h-0 flex-1 overflow-auto app-scrollbar py-1">
            {groups.length === 0 ? (
              <EmptyState
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
                  expanded={expandedGroups[group.key]}
                  viewMode={viewMode}
                  compactFolders={compactFolders}
                  expandedTreeNodes={expandedTreeNodes[group.key]}
                  onToggle={() => onToggleGroup(group.key)}
                  onToggleTreeNode={(relPath) => onToggleTreeNode(group.key, relPath)}
                  onStagePaths={(paths) => {
                    onStagePaths(paths);
                  }}
                  onUnstagePaths={(paths) => {
                    onUnstagePaths(paths);
                  }}
                  onDiscardPaths={onDiscardPaths}
                  onMarkResolved={(entry) => {
                    onMarkResolved(entry);
                  }}
                  onOpenDiff={(entry, groupKey) => {
                    onOpenDiff(entry, groupKey);
                  }}
                  onOpenFile={onOpenFile}
                  onRevealInOS={onRevealInOS}
                  onCopyPath={onCopyPath}
                  onCopyRelativePath={onCopyRelativePath}
                  onAddToGitignore={onAddToGitignore}
                  onAddPathsToGitignore={(paths) => {
                    void onAddPathsToGitignore(paths);
                  }}
                  onStashGroup={onStashGroup}
                />
              ))
            )}
          </div>
          <GitBranchBar
            workspaceId={workspaceId}
            branch={branchInfo}
            repoPath={repoPath}
            disabled={isBusy}
            capabilities={capabilities}
            autofetchIntervalMin={autofetchIntervalMin}
            autofetchFetching={autofetchFetching}
            autofetchFailed={autofetchFailed}
            onSync={onSync}
            onFetch={onFetch}
            onPull={onPull}
            onPush={onPush}
            onPublish={onPublish}
            onSetAutofetchInterval={onSetAutofetchInterval}
            onSwitchBranch={onSwitchBranch}
            onCreateFromRef={onCreateFromRef}
          />
        </>
      )}
    </>
  );
}
