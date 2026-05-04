/**
 * Cross-store transaction helpers.
 *
 * These functions coordinate mutations across useTabsStore and useLayoutStore
 * so callers never need to know the exact ordering of operations.
 */

import type { DropZone } from "@/components/workspace/dnd/types";
import { Grid } from "@/engine/split";
import { killSession } from "@/services/terminal/pty-client";
import { useLayoutStore } from "./stores/layout";
import { findLeaf } from "./stores/layout/helpers";
import type { SplitOrientation } from "./stores/layout/types";
import {
  type EditorTabProps,
  type Tab,
  type TabProps,
  type TabType,
  type TerminalTabProps,
  useTabsStore,
} from "./stores/tabs";

/**
 * Create a new tab and attach it to a group in the layout.
 */
function openTabRecord(
  workspaceId: string,
  type: TabType,
  props: TabProps,
  opts?: { groupId?: string | "active" },
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

  const tab = tabsStore.createTab(workspaceId, type, props);

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
): Tab {
  return openTabRecord(workspaceId, "editor", props, opts);
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
): { newLeafId: string; tabId: string } {
  useLayoutStore.getState().ensureLayout(workspaceId);

  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${workspaceId}`);
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
// D&D drop dispatchers
// ---------------------------------------------------------------------------

function zoneToSplit(
  zone: DropZone,
): { orientation: SplitOrientation; side: "before" | "after" } | null {
  switch (zone) {
    case "top":
      return { orientation: "vertical", side: "before" };
    case "bottom":
      return { orientation: "vertical", side: "after" };
    case "left":
      return { orientation: "horizontal", side: "before" };
    case "right":
      return { orientation: "horizontal", side: "after" };
    case "center":
      return null;
  }
}

/**
 * Result of a drop dispatch — useful for callers that want to focus the new
 * leaf or report telemetry. `null` means the drop was a no-op (self drop or
 * invalid target).
 */
export type DropResult =
  | { kind: "moved"; groupId: string; tabId: string }
  | { kind: "split"; groupId: string; tabId: string }
  | null;

/**
 * Move an existing tab into the given target zone of a destination group.
 *
 * Edge zones split the destination leaf and place the tab in the new leaf.
 * Center moves the tab into the destination leaf, optionally at a specific
 * insertion `index` (drop on a tab-bar slot — VSCode-style precise reorder).
 * Without `index`, center drops append to the end of the group.
 *
 * No-op when the result would not change the layout: same-leaf center with
 * no index (would already be there), same-leaf single-tab edge (split + hoist
 * loop), or a same-leaf reorder whose index is the tab's current position.
 *
 * The dispatcher always re-resolves the tab's owner against the live store;
 * the caller's `sourceGroupId` payload is treated as a hint only.
 */
export function moveTabToZone(
  workspaceId: string,
  tabId: string,
  target: { groupId: string; zone: DropZone; index?: number },
): DropResult {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const destLeaf = Grid.findView(layout.root, target.groupId);
  if (!destLeaf) return null;

  const owner = Grid.allLeaves(layout.root).find((l) => l.tabIds.includes(tabId));
  if (!owner) return null;

  // Self-drop guards — see architect note 4.
  if (owner.id === destLeaf.id) {
    if (target.zone === "center") {
      // Self center without index → no-op (already in this leaf, no reorder
      // intent expressed). Self center with index → reorder; allowed unless
      // the target index resolves to the current position (a true no-op).
      if (target.index === undefined) return null;
      const currentIdx = owner.tabIds.indexOf(tabId);
      if (currentIdx === target.index || currentIdx + 1 === target.index) return null;
    } else if (owner.tabIds.length === 1) {
      // Self edge with single tab → split + hoist undoes itself.
      return null;
    }
  }

  if (target.zone === "center") {
    useLayoutStore.getState().moveTab(workspaceId, tabId, destLeaf.id, target.index);
    return { kind: "moved", groupId: destLeaf.id, tabId };
  }

  const split = zoneToSplit(target.zone);
  if (!split) return null;

  // Two-step: detach (handles hoist of the source if it becomes empty) then
  // split-and-attach (single set in the store, no placeholder frame).
  // React batches these two store updates because they fire inside the same
  // event-handler tick.
  useLayoutStore.getState().detachTab(workspaceId, tabId);
  const newLeafId = useLayoutStore
    .getState()
    .splitAndAttach(workspaceId, destLeaf.id, split.orientation, split.side, tabId);
  if (!newLeafId) return null;
  return { kind: "split", groupId: newLeafId, tabId };
}

/**
 * Open a file at the given target zone — creates a new editor tab and either
 * attaches it to the destination group (center) or splits the leaf and places
 * the tab in the new pane (edge).
 *
 * This is intentionally located in operations.ts (not services/editor) so the
 * full transaction stays in one place; it parallels openTabInNewSplit.
 */
export function openFileAtZone(
  workspaceId: string,
  filePath: string,
  target: { groupId: string; zone: DropZone; index?: number },
): DropResult {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;

  const destLeaf = Grid.findView(layout.root, target.groupId);
  if (!destLeaf) return null;

  const props: EditorTabProps = { workspaceId, filePath };

  if (target.zone === "center") {
    const tab = openEditorTab(workspaceId, props, { groupId: destLeaf.id });
    if (target.index !== undefined) {
      // openEditorTab attaches at the end; re-attach at the requested index
      // (attachTab dedupes existing entries before splicing).
      useLayoutStore.getState().attachTab(workspaceId, destLeaf.id, tab.id, target.index);
    }
    return { kind: "moved", groupId: destLeaf.id, tabId: tab.id };
  }

  const split = zoneToSplit(target.zone);
  if (!split) return null;

  const tab = useTabsStore.getState().createTab(workspaceId, "editor", props);
  const newLeafId = useLayoutStore
    .getState()
    .splitAndAttach(workspaceId, destLeaf.id, split.orientation, split.side, tab.id);
  if (!newLeafId) {
    // Roll back the orphan tab record if the split failed (e.g. layout
    // disappeared mid-call). Silent failure is fine here — file open is
    // user-initiated and a reattempt is cheap.
    useTabsStore.getState().removeTab(workspaceId, tab.id);
    return null;
  }
  return { kind: "split", groupId: newLeafId, tabId: tab.id };
}

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
  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  for (const tabId of ids) {
    // Temporary layer trade-off: group close is still a state transaction, but
    // terminal PTY records must die before terminal tab records are removed.
    if (tabsById[tabId]?.type === "terminal") {
      killSession(tabId);
    }
  }

  useLayoutStore.getState().closeGroup(workspaceId, leafId);

  for (const tabId of ids) {
    useTabsStore.getState().removeTab(workspaceId, tabId);
  }
}
