/**
 * Read-only lookup helpers over the tabs/layout stores. Used by
 * `openOrRevealEditor` (preview-slot reuse, reveal-if-opened) and by
 * cross-cutting features (DnD destination matching) that need to ask
 * "is this file already open in this group?" without mutating state.
 */

import { Grid } from "@/engine/split";
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

/**
 * Find an editor tab anywhere in the workspace's layout. Prefers the
 * active group, then falls back to scanning every leaf.
 */
export function findEditorTab(workspaceId: string, filePath: string): EditorTabLocation | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  const targetPath = normalizeFilePath(filePath);
  const matchesEditorPath = (tabId: string) => {
    const tab = tabsById[tabId];
    return (
      tab?.type === "editor" &&
      normalizeFilePath((tab.props as EditorInput).filePath) === targetPath
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

/**
 * Search for an editor tab with the given filePath only within the specified
 * group (leaf). Returns null when the group does not exist or has no matching
 * tab.
 */
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

/**
 * Find the preview slot (the single isPreview=true editor tab) in a group.
 * Returns null when none exists.
 */
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
