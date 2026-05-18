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
  GitHistoryScope,
  GitPanelSegment,
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

export interface PanelUiSlice {
  setPanelSegment: (workspaceId: string, segment: GitPanelSegment) => void;
  setHistoryRef: (workspaceId: string, ref: string) => void;
  setHistoryScope: (workspaceId: string, scope: GitHistoryScope) => void;
  setExpandedGroup: (workspaceId: string, group: GitExpandedGroupKey, expanded: boolean) => void;
  toggleExpandedTreeNode: (workspaceId: string, groupKey: GitExpandedGroupKey, relPath: string) => void;
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
