import { Grid } from "@/engine";
import { useLayoutStore } from "@/state/stores/layout";
import type { Tab } from "@/state/stores/tabs";
import { useTabsStore } from "@/state/stores/tabs";
import type { EditorInput, EditorTabLocation } from "../types";
import { normalizeFilePath } from "./tab-path";

function getLeafAndTabs(
  workspaceId: string,
  groupId: string,
): { leaf: NonNullable<ReturnType<typeof Grid.findLeaf>>; tabsById: Record<string, Tab> } | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;
  const leaf = Grid.findLeaf(layout.root, groupId);
  if (!leaf) return null;
  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  return { leaf, tabsById };
}

export function findEditorTab(
  workspaceId: string,
  filePath: string,
  accept: (tabId: string) => boolean = () => true,
): EditorTabLocation | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  const targetPath = normalizeFilePath(filePath);
  const matchesEditorPath = (tabId: string) => {
    const tab = tabsById[tabId];
    return (
      tab?.type === "editor" &&
      normalizeFilePath((tab.props as EditorInput).filePath) === targetPath &&
      accept(tabId)
    );
  };

  const activeLeaf = Grid.findLeaf(layout.root, layout.activeGroupId);
  const activeTabId = activeLeaf?.tabIds.find(matchesEditorPath);
  if (activeLeaf && activeTabId) {
    return { groupId: activeLeaf.id, tabId: activeTabId };
  }

  const found = Grid.findLeafByTab(layout.root, matchesEditorPath);
  if (!found) return null;
  return { groupId: found.leaf.id, tabId: found.tabId };
}

export function findEditorTabInGroup(
  workspaceId: string,
  groupId: string,
  filePath: string,
): EditorTabLocation | null {
  const result = getLeafAndTabs(workspaceId, groupId);
  if (!result) return null;
  const { leaf, tabsById } = result;
  const targetPath = normalizeFilePath(filePath);

  const tabId = leaf.tabIds.find((id) => {
    const tab = tabsById[id];
    return (
      tab?.type === "editor" &&
      normalizeFilePath((tab.props as EditorInput).filePath) === targetPath
    );
  });

  if (!tabId) return null;
  return { groupId: leaf.id, tabId };
}

export function findPreviewTabInGroup(
  workspaceId: string,
  groupId: string,
): EditorTabLocation | null {
  const result = getLeafAndTabs(workspaceId, groupId);
  if (!result) return null;
  const { leaf, tabsById } = result;

  const tabId = leaf.tabIds.find((id) => {
    const tab = tabsById[id];
    return tab?.type === "editor" && tab.isPreview;
  });

  if (!tabId) return null;
  return { groupId: leaf.id, tabId };
}
