/**
 * Cross-store transaction helpers.
 *
 * These functions coordinate mutations across useTabsStore and useLayoutStore
 * so callers never need to know the exact ordering of operations.
 *
 * Not a zustand store — plain exported functions.
 */

import { useLayoutStore } from "./layout";
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
// splitAndMoveTab
// ---------------------------------------------------------------------------

/**
 * Split the given leaf, then move a tab from its current owner into the new leaf.
 *
 * Safe call order:
 *   1. splitGroup → create the new leaf (sourceLeafId is still valid here)
 *   2. moveTab    → detach from source, attach to newLeaf (hoist-safe; new leaf
 *                   is a separate branch so it cannot be hoisted away)
 *   3. setActiveTabInGroup → activate in new group
 */
export function splitAndMoveTab(
  workspaceId: string,
  sourceLeafId: string,
  tabId: string,
  orientation: "horizontal" | "vertical",
  side: "before" | "after",
): void {
  const layoutStore = useLayoutStore.getState();

  const newLeafId = layoutStore.splitGroup(workspaceId, sourceLeafId, orientation, side);
  if (!newLeafId) return;

  layoutStore.moveTab(workspaceId, tabId, newLeafId);
  layoutStore.setActiveTabInGroup({
    workspaceId,
    groupId: newLeafId,
    tabId,
    activateGroup: true,
  });
}
