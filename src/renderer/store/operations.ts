/**
 * Cross-store transaction helpers.
 *
 * These functions coordinate mutations across useTabsStore and useLayoutStore
 * so callers never need to know the exact ordering of operations.
 *
 * Not a zustand store — plain exported functions.
 */

import { useLayoutStore } from "./layout";
import { findLeaf } from "./layout/helpers";
import { type Tab, type TabProps, type TabType, useTabsStore } from "./tabs";

// ---------------------------------------------------------------------------
// openTab
// ---------------------------------------------------------------------------

/**
 * Create a new tab and attach it to a group in the layout.
 *
 * @param workspaceId  - Target workspace
 * @param type         - "terminal" | "editor"
 * @param props        - Type-specific tab props
 * @param opts.groupId - Which group to attach to:
 *                       undefined or "active" → active group for the workspace
 *                       explicit id            → use that leaf id directly
 */
export function openTab(
  workspaceId: string,
  type: TabType,
  props: TabProps,
  opts?: { groupId?: string | "active" },
): Tab {
  const tabsStore = useTabsStore.getState();
  const layoutStore = useLayoutStore.getState();

  // Ensure a layout slice exists for this workspace
  layoutStore.ensureLayout(workspaceId);

  // Determine target group id
  const activeGroupId = useLayoutStore.getState().byWorkspace[workspaceId]?.activeGroupId;
  let groupId: string;
  if (!opts?.groupId || opts.groupId === "active") {
    groupId = activeGroupId ?? "";
  } else {
    groupId = opts.groupId;
  }

  // Create the tab record
  const tab = tabsStore.createTab(workspaceId, type, props);

  // Attach to the layout leaf
  layoutStore.attachTab(workspaceId, groupId, tab.id);
  layoutStore.setActiveTabInGroup({
    workspaceId,
    groupId,
    tabId: tab.id,
    activateGroup: true,
  });

  return tab;
}

// ---------------------------------------------------------------------------
// closeTab
// ---------------------------------------------------------------------------

/**
 * Remove a tab from its layout leaf and delete its record from the tabs store.
 * The layout store handles empty-leaf hoist and active group re-routing.
 */
export function closeTab(workspaceId: string, tabId: string): void {
  useLayoutStore.getState().detachTab(workspaceId, tabId);
  useTabsStore.getState().removeTab(workspaceId, tabId);
}

// ---------------------------------------------------------------------------
// splitAndDuplicate
// ---------------------------------------------------------------------------

/**
 * Split the given leaf and open a duplicate of the source tab in the new leaf.
 * The source tab remains in its original leaf; a new tab record is created with
 * the same type and a deep-cloned copy of the source tab's props.
 */
export function splitAndDuplicate(
  workspaceId: string,
  sourceLeafId: string,
  sourceTabId: string,
  orientation: "horizontal" | "vertical",
  side: "before" | "after",
): { newLeafId: string; newTabId: string } | null {
  const tabsStore = useTabsStore.getState();
  const layoutStore = useLayoutStore.getState();

  const sourceTab = tabsStore.byWorkspace[workspaceId]?.[sourceTabId];
  if (!sourceTab) return null;

  const newLeafId = layoutStore.splitGroup(workspaceId, sourceLeafId, orientation, side);
  if (!newLeafId) return null;

  const newTab = useTabsStore
    .getState()
    .createTab(workspaceId, sourceTab.type, structuredClone(sourceTab.props));

  useLayoutStore.getState().attachTab(workspaceId, newLeafId, newTab.id);
  useLayoutStore.getState().setActiveTabInGroup({
    workspaceId,
    groupId: newLeafId,
    tabId: newTab.id,
    activateGroup: true,
  });

  return { newLeafId, newTabId: newTab.id };
}

// ---------------------------------------------------------------------------
// openTabInNewSplit
// ---------------------------------------------------------------------------

/**
 * Split the active group and open a brand-new tab in the resulting new leaf.
 */
export function openTabInNewSplit(
  workspaceId: string,
  type: TabType,
  props: TabProps,
  orientation: "horizontal" | "vertical",
  side: "before" | "after",
): { newLeafId: string; tabId: string } {
  useLayoutStore.getState().ensureLayout(workspaceId);

  const layout = useLayoutStore.getState().byWorkspace[workspaceId]!;
  const activeGroupId = layout.activeGroupId;

  const newLeafId = useLayoutStore
    .getState()
    .splitGroup(workspaceId, activeGroupId, orientation, side);

  const tab = useTabsStore.getState().createTab(workspaceId, type, props);

  useLayoutStore.getState().attachTab(workspaceId, newLeafId, tab.id);
  useLayoutStore.getState().setActiveTabInGroup({
    workspaceId,
    groupId: newLeafId,
    tabId: tab.id,
    activateGroup: true,
  });

  return { newLeafId, tabId: tab.id };
}

// ---------------------------------------------------------------------------
// closeGroup
// ---------------------------------------------------------------------------

/**
 * Close all tabs in a layout leaf and remove the leaf from the tree.
 * If the leaf is the sole leaf it is preserved as an empty placeholder.
 * All tab records belonging to the leaf are deleted from the tabs store.
 */
export function closeGroup(workspaceId: string, leafId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;

  const leaf = findLeaf(layout.root, leafId);
  if (!leaf) return;

  const ids = [...leaf.tabIds];

  useLayoutStore.getState().closeGroup(workspaceId, leafId);

  for (const tabId of ids) {
    useTabsStore.getState().removeTab(workspaceId, tabId);
  }
}

// ---------------------------------------------------------------------------
// seedDefaultTerminalIfEmpty
// ---------------------------------------------------------------------------

/**
 * Open a single terminal tab for a workspace when no tabs exist yet.
 * Idempotent — does nothing if the workspace already has at least one tab.
 */
export function seedDefaultTerminalIfEmpty(workspaceId: string, rootPath: string): void {
  const tabs = useTabsStore.getState().byWorkspace[workspaceId];
  if (tabs && Object.keys(tabs).length > 0) return;
  openTab(workspaceId, "terminal", { cwd: rootPath });
}
