/**
 * git-panel-ui.ts — slice creator.
 *
 * Slice: git-panel UI state actions — setPanelSegment, setHistoryRef,
 * setHistoryScope, setExpandedGroup, toggleExpandedTreeNode, setCommitDraft,
 * flushCommitDraft, flushAllCommitDrafts, setCommitOption.
 */

import type {
  GitCommitOptions,
  GitExpandedGroupKey,
  GitExpandedGroups,
  GitExpandedTreeNodes,
  GitHistoryScope,
  GitPanelSegment,
  GitStatusEntry,
} from "../../../../shared/git/types";
import { DEFAULT_GIT_PANEL_STATE } from "../../../../shared/git/types";
import {
  flushAllCommitDraftSaves,
  flushCommitDraftSave,
  scheduleCommitDraftSave,
} from "./draft-persistence";
import { persistPanelState } from "./panel-state-io";
import { createDefaultSession } from "./session-defaults";
import type { GitStoreContext } from "./store-context";

/**
 * Collect every directory prefix that appears across a list of status
 * entries. `expandAllTrees` writes this set into `expandedTreeNodes[groupKey]`
 * so the renderer's tree view reveals every leaf without a per-row click.
 */
function dirsFromEntries(entries: readonly GitStatusEntry[]): string[] {
  const dirs = new Set<string>();
  for (const entry of entries) {
    const parts = entry.relPath.split("/");
    // Only intermediate segments are dirs; the final segment is the file.
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return [...dirs];
}

export interface PanelUiSlice {
  setPanelSegment: (workspaceId: string, segment: GitPanelSegment) => void;
  setHistoryRef: (workspaceId: string, ref: string) => void;
  setHistoryScope: (workspaceId: string, scope: GitHistoryScope) => void;
  setExpandedGroup: (workspaceId: string, group: GitExpandedGroupKey, expanded: boolean) => void;
  toggleExpandedTreeNode: (workspaceId: string, groupKey: GitExpandedGroupKey, relPath: string) => void;
  /**
   * Expand every directory in every group of the active git session, and
   * flip every group header to expanded so the dirs are actually visible.
   * No-op when no session exists for the workspace.
   */
  expandAllTrees: (workspaceId: string) => void;
  /**
   * Collapse every directory in every group, leaving group headers untouched
   * (users typically want "show only top-level files of each group" — not
   * "hide the groups entirely"). No-op when no session exists.
   */
  collapseAllTrees: (workspaceId: string) => void;
  setCommitDraft: (workspaceId: string, text: string) => void;
  flushCommitDraft: (workspaceId: string) => void;
  flushAllCommitDrafts: () => void;
  setCommitOption: <K extends keyof GitCommitOptions>(workspaceId: string, option: K, value: GitCommitOptions[K]) => void;
}

export function createPanelUiSlice(ctx: GitStoreContext): PanelUiSlice {
  const { get, updateExistingSession, upsertSession } = ctx;

  return {
    setPanelSegment(workspaceId, panelSegment) {
      upsertSession(workspaceId, (session) => ({ ...session, panelSegment }));
      persistPanelState(workspaceId, { panelSegment });
    },

    setHistoryRef(workspaceId, historyRef) {
      const ref = historyRef.trim() || DEFAULT_GIT_PANEL_STATE.historyRef;
      upsertSession(workspaceId, (session) => ({ ...session, historyRef: ref }));
      persistPanelState(workspaceId, { historyRef: ref });
    },

    setHistoryScope(workspaceId, historyScope) {
      upsertSession(workspaceId, (session) => ({ ...session, historyScope }));
      persistPanelState(workspaceId, { historyScope });
    },

    setExpandedGroup(workspaceId, group, expanded) {
      const session = get().sessions.get(workspaceId);
      if (!session) return;

      const expandedGroups = { ...session.expandedGroups, [group]: expanded };
      updateExistingSession(workspaceId, (cur) => ({ ...cur, expandedGroups }));
      persistPanelState(workspaceId, { expandedGroups });
    },

    toggleExpandedTreeNode(workspaceId, groupKey, relPath) {
      const session = get().sessions.get(workspaceId);
      if (!session) return;

      const current = session.expandedTreeNodes[groupKey];
      const isExpanded = current.includes(relPath);
      const next = isExpanded ? current.filter((p) => p !== relPath) : [...current, relPath];
      const expandedTreeNodes = { ...session.expandedTreeNodes, [groupKey]: next };
      updateExistingSession(workspaceId, (cur) => ({ ...cur, expandedTreeNodes }));
      persistPanelState(workspaceId, { expandedTreeNodes });
    },

    expandAllTrees(workspaceId) {
      const session = get().sessions.get(workspaceId);
      if (!session) return;
      const status = session.status;
      if (!status) return;

      const expandedTreeNodes: GitExpandedTreeNodes = {
        merge: dirsFromEntries(status.merge),
        staged: dirsFromEntries(status.staged),
        working: dirsFromEntries(status.working),
        untracked: dirsFromEntries(status.untracked),
      };
      const expandedGroups: GitExpandedGroups = {
        merge: true,
        staged: true,
        working: true,
        untracked: true,
      };
      updateExistingSession(workspaceId, (cur) => ({
        ...cur,
        expandedTreeNodes,
        expandedGroups,
      }));
      persistPanelState(workspaceId, { expandedTreeNodes, expandedGroups });
    },

    collapseAllTrees(workspaceId) {
      const session = get().sessions.get(workspaceId);
      if (!session) return;
      const expandedTreeNodes: GitExpandedTreeNodes = {
        merge: [],
        staged: [],
        working: [],
        untracked: [],
      };
      updateExistingSession(workspaceId, (cur) => ({ ...cur, expandedTreeNodes }));
      persistPanelState(workspaceId, { expandedTreeNodes });
    },

    setCommitDraft(workspaceId, text) {
      upsertSession(workspaceId, (session) => ({ ...session, commitDraft: text }));
      scheduleCommitDraftSave(workspaceId, text);
    },

    flushCommitDraft(workspaceId) {
      flushCommitDraftSave(workspaceId);
    },

    flushAllCommitDrafts() {
      flushAllCommitDraftSaves();
    },

    setCommitOption(workspaceId, option, value) {
      const session = get().sessions.get(workspaceId) ?? createDefaultSession();
      const commitOptions = { ...session.commitOptions, [option]: value };
      upsertSession(workspaceId, (cur) => ({ ...cur, commitOptions }));
      persistPanelState(workspaceId, { commitOptions });
    },
  };
}
