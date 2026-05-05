/**
 * Tab lifecycle transactions across the tabs and layout stores.
 *
 * These helpers coordinate the two stores so callers never need to know
 * the exact ordering — create the tab record, attach to the layout leaf,
 * route activation, etc. Domain services (services/editor, services/
 * terminal) call into this module rather than touching the stores
 * directly so the cross-store invariants live in one place.
 */

import { useLayoutStore } from "../stores/layout";
import {
  type EditorTabProps,
  type Tab,
  type TabProps,
  type TabType,
  type TerminalTabProps,
  useTabsStore,
} from "../stores/tabs";

/**
 * Create a new tab and attach it to a group in the layout.
 */
function openTabRecord(
  workspaceId: string,
  type: TabType,
  props: TabProps,
  opts?: { groupId?: string | "active" },
  isPreview = false,
): Tab {
  const tabsStore = useTabsStore.getState();
  const layoutStore = useLayoutStore.getState();

  layoutStore.ensureLayout(workspaceId);

  const activeGroupId = useLayoutStore.getState().byWorkspace[workspaceId]?.activeGroupId;
  let groupId: string;
  if (!opts?.groupId || opts.groupId === "active") {
    groupId = activeGroupId ?? "";
  } else {
    groupId = opts.groupId;
  }

  const tab = tabsStore.createTab(workspaceId, type, props, isPreview);

  layoutStore.attachTab(workspaceId, groupId, tab.id);
  layoutStore.setActiveTabInGroup({
    workspaceId,
    groupId,
    tabId: tab.id,
    activateGroup: true,
  });

  return tab;
}

export function openTab(
  workspaceId: string,
  type: "terminal",
  props: TerminalTabProps,
  opts?: { groupId?: string | "active" },
): Tab {
  return openTabRecord(workspaceId, type, props, opts);
}

/**
 * @internal Use services/editor.openOrRevealEditor for user-facing editor opens.
 */
export function openEditorTab(
  workspaceId: string,
  props: EditorTabProps,
  opts?: { groupId?: string | "active" },
  isPreview = false,
): Tab {
  return openTabRecord(workspaceId, "editor", props, opts, isPreview);
}

export function revealTab(workspaceId: string, groupId: string, tabId: string): void {
  useLayoutStore.getState().setActiveTabInGroup({
    workspaceId,
    groupId,
    tabId,
    activateGroup: true,
  });
}

/**
 * Remove a tab from its layout leaf and delete its record from the tabs store.
 * The layout store handles empty-leaf hoist and active group re-routing.
 *
 * @internal — Use services/editor.closeEditor or services/terminal.closeTerminal
 * for user-facing closes.
 */
export function closeTab(workspaceId: string, tabId: string): void {
  useLayoutStore.getState().detachTab(workspaceId, tabId);
  useTabsStore.getState().removeTab(workspaceId, tabId);
}

/**
 * Split the given leaf and open a duplicate of the source tab in the new leaf.
 * The source tab remains in its original leaf; a new tab record is created with
 * the same type and a deep-cloned copy of the source tab's props.
 *
 * @deprecated Use services/editor.openOrRevealEditor or services/terminal.openTerminal
 * with a newSplit option for user-facing split opens.
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

/**
 * Split the active group and open a brand-new tab in the resulting new leaf.
 *
 * @internal Services-only transaction helper; use domain services for
 * user-facing split opens.
 */
export function openTabInNewSplit(
  workspaceId: string,
  type: TabType,
  props: TabProps,
  orientation: "horizontal" | "vertical",
  side: "before" | "after",
  isPreview = false,
): { newLeafId: string; tabId: string } {
  useLayoutStore.getState().ensureLayout(workspaceId);

  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${workspaceId}`);
  const activeGroupId = layout.activeGroupId;

  const newLeafId = useLayoutStore
    .getState()
    .splitGroup(workspaceId, activeGroupId, orientation, side);

  const tab = useTabsStore.getState().createTab(workspaceId, type, props, isPreview);

  useLayoutStore.getState().attachTab(workspaceId, newLeafId, tab.id);
  useLayoutStore.getState().setActiveTabInGroup({
    workspaceId,
    groupId: newLeafId,
    tabId: tab.id,
    activateGroup: true,
  });

  return { newLeafId, tabId: tab.id };
}
