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
 * Owns one piece of state: which file the rows' shared context menu is
 * open for. Every other value and callback comes from props.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  GitCommitOptions,
  GitExpandedGroupKey,
  GitPanelSegment,
  GitStatusEntry,
} from "../../../../../shared/git/types";
import type { ViewMode } from "../../../../../shared/types/panel";
import type { useBannerDismissal } from "../../../../hooks/use-banner-dismissal";
import type { GitStoreError } from "../../../../state/stores/git";
import type { GitActionButtonState } from "../../../../state/stores/git/action-button";
import { EmptyState } from "../../../ui/empty-state";
import type { GitCommitMenuEnablement } from "../commit/commit-button";
import { GitCommitInput } from "../commit/commit-input";
import {
  type GitContextMenuPoint,
  GitFileContextMenu,
  type GitFileContextMenuActions,
} from "../file-row/file-context-menu";
import { GitGroup, type GitGroupActions } from "../file-row/group";
import { gitFileMenuActions } from "../file-row/row";
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
  operationNotice: ReturnType<typeof useBannerDismissal>;
  lastError: GitStoreError | null | undefined;
  inFlightKind: string | null | undefined;
  onContinueOp: () => void;
  onAbortOp: () => void;

  // Commit input props: the input reads the draft itself, so typing renders only it.
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
  /**
   * What the groups and their rows do, all but opening the file menu, which
   * the body shares among them. Keeps its identity, so the groups render
   * only for their own files.
   */
  fileActions: Omit<GitGroupActions, "openMenu">;
}

export function GitPanelBody({
  workspaceId,
  panelSegment,
  isBusy,
  onSegmentChange,
  historyRef,
  onHistoryRefChange,
  activeOperation,
  operationNotice,
  lastError,
  inFlightKind,
  onContinueOp,
  onAbortOp,
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
  fileActions,
}: GitPanelBodyProps) {
  const { t } = useTranslation("files");
  // One context menu for every row, open for one file at a time: a menu for
  // each row cost a Radix menu per file, and the panel lists every untracked one.
  const [menu, setMenu] = useState<GitFileMenuTarget | null>(null);
  const actions = useMemo<GitGroupActions>(
    () => ({
      ...fileActions,
      openMenu: (entry, groupKey, point) => setMenu({ entry, groupKey, point }),
    }),
    [fileActions],
  );
  // Closed, it keeps its file: the item picked runs once the menu has closed.
  const closeMenu = useCallback(
    () => setMenu((open) => (open ? { ...open, point: null } : open)),
    [],
  );
  // The file as its row now shows it. The menu goes with the row, as when
  // each row had its own: a file that left its group closes its menu.
  const menuEntry = menu ? listedEntry(groups, menu.groupKey, menu.entry) : null;
  const menuPoint = menuEntry ? (menu?.point ?? null) : null;
  useEffect(() => {
    if (menu?.point && !menuEntry) closeMenu();
  }, [menu, menuEntry, closeMenu]);
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
              notice={operationNotice}
              error={lastError}
              inFlightKind={inFlightKind}
              onContinue={onContinueOp}
              onAbort={onAbortOp}
            />
          ) : (
            <GitCommitInput
              workspaceId={workspaceId}
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
                title={t("git.panel.noChanges.title")}
                description={t("git.panel.noChanges.description")}
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
                  actions={actions}
                />
              ))
            )}
          </div>
          <GitFileContextMenu
            point={menuPoint}
            groupKey={menu?.groupKey ?? "working"}
            actions={
              menu
                ? gitFileMenuActions(menuEntry ?? menu.entry, menu.groupKey, actions)
                : CLOSED_MENU
            }
            onClose={closeMenu}
          />
        </>
      )}
    </>
  );
}

/** The file the rows' shared menu is for, and where it opened; no point once closed. */
interface GitFileMenuTarget {
  entry: GitStatusEntry;
  groupKey: GitExpandedGroupKey;
  point: GitContextMenuPoint | null;
}

/** The entry a group lists for the row `entry` was in (rows are keyed by both paths). */
function listedEntry(
  groups: readonly GitGroupDescriptor[],
  groupKey: GitExpandedGroupKey,
  entry: GitStatusEntry,
): GitStatusEntry | null {
  const group = groups.find((each) => each.key === groupKey);
  return (
    group?.entries.find(
      (each) => each.relPath === entry.relPath && each.oldRelPath === entry.oldRelPath,
    ) ?? null
  );
}

function noop(): void {}

/** The menu's actions before any row opened it, while it shows nothing. */
const CLOSED_MENU: GitFileContextMenuActions = {
  openFile: noop,
  openChanges: noop,
  revealInOS: noop,
  copyPath: noop,
  copyRelativePath: noop,
  addToGitignore: noop,
};
