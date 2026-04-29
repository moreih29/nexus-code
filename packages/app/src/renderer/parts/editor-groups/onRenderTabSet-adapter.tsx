import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import type { BorderNode, ITabSetRenderValues, TabSetNode } from "flexlayout-react";
import { Save, SplitSquareHorizontal } from "lucide-react";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import type { EditorPaneId, EditorPaneState, EditorTab, EditorTabId } from "../../services/editor-types";
import { Button } from "../../components/ui/button";

export interface EditorGroupsOnRenderTabSetGroupTab {
  id: EditorTabId;
  title?: string;
  kind?: string;
  workspaceId?: WorkspaceId | null;
  resourcePath?: string | null;
}

export interface EditorGroupsOnRenderTabSetGroup {
  id: EditorPaneId;
  tabs: readonly EditorGroupsOnRenderTabSetGroupTab[];
  activeTabId: EditorTabId | null;
}

export interface EditorGroupsOnRenderTabSetAdapterOptions {
  groups: readonly EditorGroupsOnRenderTabSetGroup[];
  panes: readonly EditorPaneState[];
  onActivateGroup?(groupId: EditorPaneId): void;
  onSaveTab(tabId: EditorTabId): void;
  onSplitRight(): void;
}

export interface EditorGroupsOnRenderTabSetState {
  groupId: EditorPaneId;
  activeTab: EditorGroupsOnRenderTabSetGroupTab | null;
  activeEditorTab: EditorTab | null;
  showSave: boolean;
}

type TabSetNodeLike = Pick<TabSetNode | BorderNode, "getId" | "getSelectedNode">;
type MutableTabSetRenderValues = ITabSetRenderValues & {
  stickyButtons?: ReactNode[];
  buttons?: ReactNode[];
};

export function createEditorGroupsOnRenderTabSetAdapter(
  options: EditorGroupsOnRenderTabSetAdapterOptions,
): (node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => void {
  const lookups = createEditorGroupsOnRenderTabSetLookups(options.groups, options.panes);

  return (node, renderValues) => {
    const state = createEditorGroupsOnRenderTabSetState(node, lookups);
    if (!state) {
      return;
    }

    const toolbarButtons = resolveToolbarButtons(renderValues);
    if (state.showSave && state.activeEditorTab) {
      toolbarButtons.push(
        <Button
          key="nexus-save-active-tab"
          type="button"
          data-action="editor-save-tab"
          data-tab-id={state.activeEditorTab.id}
          aria-label={`Save ${state.activeEditorTab.title}`}
          title={`Save ${state.activeEditorTab.title}`}
          variant="outline"
          size="xs"
          disabled={state.activeEditorTab.saving}
          className="h-6 px-2 text-[11px]"
          onMouseDown={stopTabSetToolbarEvent}
          onClick={(event) => {
            stopTabSetToolbarEvent(event);
            options.onActivateGroup?.(state.groupId);
            options.onSaveTab(state.activeEditorTab!.id);
          }}
        >
          <Save aria-hidden="true" className="size-3" strokeWidth={1.75} />
          {state.activeEditorTab.saving ? "Saving" : "Save"}
        </Button>,
      );
    }

    toolbarButtons.push(
      <Button
        key="nexus-split-right"
        type="button"
        data-action="editor-split-right"
        aria-label="Split right (⌘\\)"
        title="Split right (⌘\\)"
        variant="ghost"
        size="icon-xs"
        className="h-6 w-6 text-muted-foreground hover:text-foreground"
        onMouseDown={stopTabSetToolbarEvent}
        onClick={(event) => {
          stopTabSetToolbarEvent(event);
          options.onActivateGroup?.(state.groupId);
          options.onSplitRight();
        }}
      >
        <SplitSquareHorizontal aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      </Button>,
    );
  };
}

export interface EditorGroupsOnRenderTabSetLookups {
  groupById: ReadonlyMap<EditorPaneId, EditorGroupsOnRenderTabSetGroup>;
  editorTabById: ReadonlyMap<EditorTabId, EditorTab>;
}

export function createEditorGroupsOnRenderTabSetLookups(
  groups: readonly EditorGroupsOnRenderTabSetGroup[],
  panes: readonly EditorPaneState[],
): EditorGroupsOnRenderTabSetLookups {
  const groupById = new Map<EditorPaneId, EditorGroupsOnRenderTabSetGroup>();
  for (const group of groups) {
    groupById.set(group.id, group);
  }

  const editorTabById = new Map<EditorTabId, EditorTab>();
  for (const pane of panes) {
    for (const tab of pane.tabs) {
      editorTabById.set(tab.id, tab);
    }
  }

  return { groupById, editorTabById };
}

export function createEditorGroupsOnRenderTabSetState(
  node: TabSetNodeLike,
  lookups: EditorGroupsOnRenderTabSetLookups,
): EditorGroupsOnRenderTabSetState | null {
  const groupId = node.getId();
  const group = lookups.groupById.get(groupId) ?? null;
  if (!group) {
    return null;
  }

  const selectedTabId = node.getSelectedNode()?.getId() ?? null;
  const activeTab = resolveActiveTab(group, selectedTabId);
  const activeEditorTab = activeTab ? lookups.editorTabById.get(activeTab.id) ?? null : null;
  const activeKind = activeTab?.kind ?? activeEditorTab?.kind ?? null;
  const showSave = activeKind === "file" && activeEditorTab?.dirty === true;

  return {
    groupId,
    activeTab,
    activeEditorTab,
    showSave,
  };
}

function resolveActiveTab(
  group: EditorGroupsOnRenderTabSetGroup,
  selectedTabId: EditorTabId | null,
): EditorGroupsOnRenderTabSetGroupTab | null {
  if (selectedTabId) {
    const selectedTab = group.tabs.find((tab) => tab.id === selectedTabId);
    if (selectedTab) {
      return selectedTab;
    }
  }

  if (group.activeTabId) {
    const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId);
    if (activeTab) {
      return activeTab;
    }
  }

  return group.tabs[0] ?? null;
}

function resolveToolbarButtons(renderValues: ITabSetRenderValues): ReactNode[] {
  const values = renderValues as MutableTabSetRenderValues;
  if (Array.isArray(values.stickyButtons)) {
    return values.stickyButtons;
  }

  if (Array.isArray(values.buttons)) {
    return values.buttons;
  }

  values.buttons = [];
  return values.buttons;
}

function stopTabSetToolbarEvent(event: ReactMouseEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}
