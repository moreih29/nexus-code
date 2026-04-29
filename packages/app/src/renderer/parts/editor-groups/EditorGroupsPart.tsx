import { useCallback, useMemo, type ReactNode } from "react";

import { Actions, Layout, type Action, type Model, type TabNode } from "flexlayout-react";

import { EditorPane } from "../../components/EditorPane";
import type { SplitEditorPaneProps } from "../../components/SplitEditorPane";

type EditorPaneId = string;
type EditorTabId = string;
type EditorPaneState = SplitEditorPaneProps["panes"][number];
type EditorGroupTabKind = "file" | "diff" | "terminal" | "preview";

export interface EditorGroup {
  id: string;
  tabs: readonly { id: string; kind: EditorGroupTabKind | string }[];
  activeTabId: string | null;
}

const EDITOR_GROUP_TAB_COMPONENT = "nexus-editor-group-tab";

export const EDITOR_GROUP_GRID_SLOT_COUNT = 6;
export const EDITOR_GROUP_DOCKABLE_TAB_KINDS: readonly EditorGroupTabKind[] = [
  "file",
  "diff",
  "terminal",
  "preview",
];

export interface EditorGroupsPartProps extends SplitEditorPaneProps {
  activeGroupId: string | null;
  groups: readonly EditorGroup[];
  layoutSnapshot: unknown;
  model: Model;
  gridShell?: ReactNode;
}

export function EditorGroupsPart({
  activeGroupId,
  groups,
  gridShell,
  layoutSnapshot,
  model,
  activeWorkspaceId,
  activeWorkspaceName,
  panes,
  activePaneId,
  onActivatePane,
  onSplitRight,
  onOpenFileFromTreeDrop: _onOpenFileFromTreeDrop,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onCopyTabPath,
  onRevealTabInFinder,
  onTearOffTabToFloating,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
  onReorderTab: _onReorderTab,
  onMoveTabToPane: _onMoveTabToPane,
  onSplitTabRight: _onSplitTabRight,
}: EditorGroupsPartProps): JSX.Element {
  const panesById = useMemo(() => createPaneLookup(panes), [panes]);
  const paneIdByTabId = useMemo(() => createPaneIdByTabLookup(panes), [panes]);

  const factory = useCallback((node: TabNode) => {
    const tabId = node.getId();
    const paneId = node.getParent()?.getId() ?? paneIdByTabId.get(tabId) ?? activePaneId;
    const pane = panesById.get(paneId) ?? createEmptyPane(paneId, tabId);
    const workspaceTabs = activeWorkspaceId
      ? pane.tabs.filter((tab) => tab.workspaceId === activeWorkspaceId)
      : [];
    const activeTabId = workspaceTabs.some((tab) => tab.id === tabId)
      ? tabId
      : normalizeActiveTabId(workspaceTabs, pane.activeTabId);

    return (
      <div
        data-editor-flexlayout-tab-content="true"
        data-editor-group-id={pane.id}
        data-editor-group-tab-id={tabId}
        className="h-full min-h-0 min-w-0 bg-background"
      >
        <EditorPane
          activeWorkspaceName={activeWorkspaceName}
          paneId={pane.id}
          active={pane.id === activeGroupId}
          tabs={workspaceTabs}
          activeTabId={activeTabId}
          onActivatePane={onActivatePane}
          onActivateTab={(nextTabId) => onActivateTab(pane.id, nextTabId)}
          onCloseTab={(nextTabId) => onCloseTab(pane.id, nextTabId)}
          onCloseOtherTabs={(nextTabId) => onCloseOtherTabs?.(pane.id, nextTabId)}
          onCloseTabsToRight={(nextTabId) => onCloseTabsToRight?.(pane.id, nextTabId)}
          onCloseAllTabs={() => onCloseAllTabs?.(pane.id)}
          onCopyTabPath={onCopyTabPath}
          onRevealTabInFinder={onRevealTabInFinder}
          onTearOffTabToFloating={(nextTabId) => onTearOffTabToFloating?.(pane.id, nextTabId)}
          onSaveTab={onSaveTab}
          onChangeContent={onChangeContent}
          onApplyWorkspaceEdit={onApplyWorkspaceEdit}
          onSplitRight={onSplitRight}
        />
      </div>
    );
  }, [
    activeGroupId,
    activePaneId,
    activeWorkspaceId,
    activeWorkspaceName,
    onActivatePane,
    onActivateTab,
    onChangeContent,
    onCloseAllTabs,
    onCloseOtherTabs,
    onCloseTab,
    onCloseTabsToRight,
    onCopyTabPath,
    onApplyWorkspaceEdit,
    onRevealTabInFinder,
    onSaveTab,
    onSplitRight,
    onTearOffTabToFloating,
    paneIdByTabId,
    panesById,
  ]);

  const handleAction = useCallback((action: Action): Action | undefined => {
    if (action.type === Actions.DELETE_TAB) {
      const tabId = typeof action.data.node === "string" ? action.data.node : null;
      const groupId = tabId ? model.getNodeById(tabId)?.getParent()?.getId() : null;
      if (tabId && groupId) {
        onCloseTab(groupId, tabId);
        return undefined;
      }
    }

    if (action.type === Actions.DELETE_TABSET) {
      const groupId = typeof action.data.node === "string" ? action.data.node : null;
      const group = groupId ? groups.find((candidate) => candidate.id === groupId) : null;
      if (groupId && group) {
        for (const tab of group.tabs) {
          onCloseTab(groupId, tab.id);
        }
        return undefined;
      }
    }

    return action;
  }, [groups, model, onCloseTab]);

  return (
    <section
      data-component="editor-groups-part"
      data-editor-grid-provider="flexlayout-model"
      data-editor-grid-capacity={EDITOR_GROUP_GRID_SLOT_COUNT}
      data-editor-grid-tab-kinds={EDITOR_GROUP_DOCKABLE_TAB_KINDS.join(" ")}
      data-editor-groups-component={EDITOR_GROUP_TAB_COMPONENT}
      data-editor-groups-serializable={layoutSnapshot ? "true" : "false"}
      className="nexus-flexlayout relative h-full min-h-0 min-w-0 bg-background"
    >
      {gridShell ?? <EditorGroupsGridShell groups={groups} />}
      <Layout model={model} factory={factory} onAction={handleAction} supportsPopout={false} realtimeResize />
    </section>
  );
}

export interface EditorGroupsGridShellProps {
  groups: readonly EditorGroup[];
  slotCount?: number;
}

export function EditorGroupsGridShell({
  groups,
  slotCount = EDITOR_GROUP_GRID_SLOT_COUNT,
}: EditorGroupsGridShellProps): JSX.Element {
  const slots = createEditorGroupGridSlots(groups, slotCount);

  return (
    <div
      aria-hidden="true"
      data-editor-grid-shell="true"
      data-editor-grid-slot-count={slotCount}
      data-editor-grid-drop-zones="top right bottom left center"
      className="pointer-events-none absolute inset-0 opacity-0"
    >
      {slots.map((slot) => (
        <div
          key={slot.index}
          data-editor-grid-slot={slot.index}
          data-editor-group-id={slot.groupId ?? ""}
          data-editor-group-tab-count={slot.tabCount}
          data-editor-group-active-tab-id={slot.activeTabId ?? ""}
          data-editor-group-terminal-ready={slot.acceptsTerminal ? "true" : "false"}
          data-editor-group-tab-kinds={EDITOR_GROUP_DOCKABLE_TAB_KINDS.join(" ")}
        />
      ))}
    </div>
  );
}

export interface EditorGroupGridSlot {
  index: number;
  groupId: string | null;
  tabCount: number;
  activeTabId: string | null;
  acceptsTerminal: boolean;
}

export function createEditorGroupGridSlots(
  groups: readonly EditorGroup[],
  slotCount = EDITOR_GROUP_GRID_SLOT_COUNT,
): EditorGroupGridSlot[] {
  return Array.from({ length: slotCount }, (_, index) => {
    const group = groups[index] ?? null;

    return {
      index: index + 1,
      groupId: group?.id ?? null,
      tabCount: group?.tabs.length ?? 0,
      activeTabId: group?.activeTabId ?? null,
      acceptsTerminal: EDITOR_GROUP_DOCKABLE_TAB_KINDS.includes("terminal"),
    };
  });
}

function createPaneLookup(panes: readonly EditorPaneState[]): Map<EditorPaneId, EditorPaneState> {
  return new Map(panes.map((pane) => [pane.id, pane]));
}

function createPaneIdByTabLookup(panes: readonly EditorPaneState[]): Map<EditorTabId, EditorPaneId> {
  return new Map(panes.flatMap((pane) => pane.tabs.map((tab) => [tab.id, pane.id] as const)));
}

function createEmptyPane(id: EditorPaneId, activeTabId: EditorTabId | null): EditorPaneState {
  return { id, tabs: [], activeTabId };
}

function normalizeActiveTabId(tabs: readonly { id: EditorTabId }[], activeTabId: EditorTabId | null): EditorTabId | null {
  return activeTabId && tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : tabs[0]?.id ?? null;
}
