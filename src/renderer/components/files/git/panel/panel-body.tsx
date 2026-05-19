/**
 * GitPanelBody renders the main content area of the Source Control panel for
 * a detected git repository.
 *
 * Owns: HistorySegmentToggle · HistoryPanel · OperationBanner ·
 *       GitCommitInput · file-group list.
 *
 * Branch identity / sync actions previously lived in a panel footer
 * (GitBranchBar) — that footer was removed so the file panel's island
 * shape (rounded corners on its host) reads cleanly. Branch switching is
 * now reached from the status bar's branch button; fetch/pull/push are
 * available from GitMoreMenu (header) and the commit button menu.
 *
 * Owns no state — all values and callbacks come from props.
 */

import type {
  GitCommitOptions,
  GitExpandedGroupKey,
  GitPanelSegment,
  GitStatusEntry,
} from "../../../../../shared/git/types";
import type { ViewMode } from "../../../../../shared/types/panel";
import type { GitStoreError } from "../../../../state/stores/git";
import type { GitActionButtonState } from "../../../../state/stores/git/action-button";
import { EmptyState } from "../../../ui/empty-state";
import type { GitCommitMenuEnablement } from "../commit/commit-button";
import { GitCommitInput } from "../commit/commit-input";
import { GitGroup } from "../file-row/group";
import { HistoryPanel } from "../history/panel";
import { HistorySegmentToggle } from "../history/segment-toggle";
import type { GitGroupDescriptor } from "../utils/status-utils";
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
        </>
      )}
    </>
  );
}
