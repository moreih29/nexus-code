import type { CenterWorkbenchActiveArea } from "../components/CenterWorkbench";
import type { BottomPanelServiceStore } from "../services/bottom-panel-service";
import {
  DEFAULT_EDITOR_GROUP_ID,
  type EditorGroup,
  type EditorGroupId,
  type EditorGroupTab,
  type EditorGroupsServiceStore,
} from "../services/editor-groups-service";
import type { TerminalServiceStore, TerminalTab, TerminalTabId } from "../services/terminal-service";
import type { WorkspaceServiceStore } from "../services/workspace-service";
import type { WorkspaceStore } from "../stores/workspace-store";

export interface TerminalMoveCommandUiHooks {
  focusTerminalSoon?(sessionId: TerminalTabId): void;
  setActiveCenterArea?(area: CenterWorkbenchActiveArea): void;
}

export interface MoveTerminalToEditorAreaInput extends TerminalMoveCommandUiHooks {
  bottomPanelStore: BottomPanelServiceStore;
  editorGroupsService: EditorGroupsServiceStore;
  editorWorkspaceService: WorkspaceServiceStore;
  terminalService: TerminalServiceStore;
  workspaceStore: WorkspaceStore;
  sessionId?: TerminalTabId;
  targetGroupId?: EditorGroupId;
  targetIndex?: number;
}

export interface MoveTerminalToBottomPanelInput extends TerminalMoveCommandUiHooks {
  bottomPanelStore: BottomPanelServiceStore;
  editorGroupsService: EditorGroupsServiceStore;
  editorWorkspaceService: WorkspaceServiceStore;
  terminalService: TerminalServiceStore;
  sessionId?: TerminalTabId;
}

export function moveTerminalToEditorArea({
  bottomPanelStore,
  editorGroupsService,
  editorWorkspaceService,
  focusTerminalSoon,
  sessionId,
  targetGroupId,
  targetIndex,
  terminalService,
  workspaceStore,
  setActiveCenterArea,
}: MoveTerminalToEditorAreaInput): TerminalTabId | null {
  const terminalTab = resolveBottomTerminalTab({
    bottomPanelStore,
    sessionId,
    terminalService,
    workspaceStore,
  });
  if (!terminalTab) {
    return null;
  }

  const editorState = editorGroupsService.getState();
  const destinationGroupId =
    targetGroupId ??
    editorState.activeGroupId ??
    editorState.groups[0]?.id ??
    DEFAULT_EDITOR_GROUP_ID;
  const tabId = editorGroupsService.getState().attachTerminalTab(terminalTab.id, {
    groupId: destinationGroupId,
    index: targetIndex,
    title: terminalTab.title,
    workspaceId: terminalTab.workspaceId,
  }) as TerminalTabId;

  bottomPanelStore.getState().detachTerminalFromBottom(tabId);
  terminalService.getState().setActiveTab(tabId);
  editorWorkspaceService.getState().setCenterMode("editor-max");
  setActiveCenterArea?.("editor");
  focusTerminalSoon?.(tabId);

  return tabId;
}

export function moveTerminalToBottomPanel({
  bottomPanelStore,
  editorGroupsService,
  editorWorkspaceService,
  focusTerminalSoon,
  sessionId,
  terminalService,
  setActiveCenterArea,
}: MoveTerminalToBottomPanelInput): TerminalTabId | null {
  const terminalLocation = resolveEditorTerminalTabLocation(
    editorGroupsService.getState().groups,
    editorGroupsService.getState().activeGroupId,
    sessionId,
  );
  if (!terminalLocation || !terminalService.getState().tabs.some((tab) => tab.id === terminalLocation.tab.id)) {
    return null;
  }

  const terminalTabId = terminalLocation.tab.id as TerminalTabId;
  editorGroupsService.getState().closeTab(terminalLocation.group.id, terminalTabId);
  collapseEmptyEditorGroups(editorGroupsService, terminalLocation.group.id);
  bottomPanelStore.getState().attachTerminalToBottom(terminalTabId);
  bottomPanelStore.getState().setActiveView("terminal");
  bottomPanelStore.getState().setExpanded(true);
  terminalService.getState().setActiveTab(terminalTabId);
  editorWorkspaceService.getState().setCenterMode("split");
  setActiveCenterArea?.("bottom-panel");
  focusTerminalSoon?.(terminalTabId);

  return terminalTabId;
}

function resolveBottomTerminalTab({
  bottomPanelStore,
  sessionId,
  terminalService,
  workspaceStore,
}: Pick<MoveTerminalToEditorAreaInput, "bottomPanelStore" | "sessionId" | "terminalService" | "workspaceStore">): TerminalTab | null {
  const terminalState = terminalService.getState();
  const bottomPanelState = bottomPanelStore.getState();

  if (sessionId) {
    const requestedTab = terminalState.tabs.find((tab) => tab.id === sessionId) ?? null;
    return requestedTab && bottomPanelState.isTerminalAttachedToBottom(requestedTab.id)
      ? requestedTab
      : null;
  }

  const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
  if (!activeWorkspaceId) {
    return null;
  }

  const visibleWorkspaceTabs = terminalState
    .getTabs(activeWorkspaceId)
    .filter((tab) => bottomPanelState.isTerminalAttachedToBottom(tab.id));
  const activeWorkspaceTab = terminalState.getActiveTab(activeWorkspaceId);

  if (activeWorkspaceTab && visibleWorkspaceTabs.some((tab) => tab.id === activeWorkspaceTab.id)) {
    return activeWorkspaceTab;
  }

  return visibleWorkspaceTabs.at(-1) ?? null;
}

function resolveEditorTerminalTabLocation(
  groups: readonly EditorGroup[],
  activeGroupId: EditorGroupId | null,
  sessionId?: TerminalTabId,
): { group: EditorGroup; tab: EditorGroupTab } | null {
  if (sessionId) {
    return findEditorTerminalTabLocation(groups, (tab) => tab.id === sessionId);
  }

  const activeGroup = activeGroupId
    ? groups.find((group) => group.id === activeGroupId) ?? null
    : null;
  if (!activeGroup?.activeTabId) {
    return null;
  }

  const activeTabId = activeGroup.activeTabId;
  return findEditorTerminalTabLocation([activeGroup], (tab) => tab.id === activeTabId);
}

function findEditorTerminalTabLocation(
  groups: readonly EditorGroup[],
  predicate: (tab: EditorGroupTab) => boolean,
): { group: EditorGroup; tab: EditorGroupTab } | null {
  for (const group of groups) {
    const tab = group.tabs.find((candidate) => candidate.kind === "terminal" && predicate(candidate)) ?? null;
    if (tab) {
      return { group, tab };
    }
  }

  return null;
}

function collapseEmptyEditorGroups(
  editorGroupsService: EditorGroupsServiceStore,
  preferredActiveGroupId: EditorGroupId | null,
): void {
  const state = editorGroupsService.getState();
  if (state.groups.length <= 1 || state.groups.every((group) => group.tabs.length > 0)) {
    return;
  }

  const nonEmptyGroups = state.groups
    .filter((group) => group.tabs.length > 0)
    .map((group) => ({ ...group, tabs: [...group.tabs] }));
  const nextGroups = nonEmptyGroups.length > 0
    ? nonEmptyGroups
    : [{ id: DEFAULT_EDITOR_GROUP_ID, tabs: [], activeTabId: null }];
  const nextActiveGroupId = nextGroups.some((group) => group.id === preferredActiveGroupId)
    ? preferredActiveGroupId
    : nextGroups[0]?.id ?? null;

  editorGroupsService.getState().setGroups(nextGroups, nextActiveGroupId);
}
