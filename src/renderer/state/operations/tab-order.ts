/**
 * Pinned tabs sit in front of a group's other tabs.
 *
 * The tab bar draws pinned tabs first, and drop indices, "Close to the
 * Right", tab cycling and neighbour activation all read the group's
 * stored `tabIds`. These helpers keep the stored order equal to the drawn
 * order so every one of those agrees with what the user sees.
 */

import { useLayoutStore } from "../stores/layout";
import { allLeaves, findLeaf } from "../stores/layout/helpers";
import { useTabsStore } from "../stores/tabs";

/** `tabIds` with pinned tabs first; each part keeps its relative order. */
export function pinnedFirst(
  tabIds: readonly string[],
  isPinned: (tabId: string) => boolean,
): string[] {
  return [...tabIds.filter(isPinned), ...tabIds.filter((id) => !isPinned(id))];
}

function pinnedLookup(workspaceId: string): (tabId: string) => boolean {
  const record = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  return (tabId) => record[tabId]?.isPinned === true;
}

/** Moves a group's pinned tabs in front of the rest, keeping each part's order. */
export function normalizeGroupTabOrder(workspaceId: string, groupId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const leaf = layout ? findLeaf(layout.root, groupId) : null;
  if (!leaf) return;
  useLayoutStore
    .getState()
    .setGroupTabOrder(workspaceId, groupId, pinnedFirst(leaf.tabIds, pinnedLookup(workspaceId)));
}

/** Normalizes every group of the workspace (e.g. after restoring a layout). */
export function normalizeWorkspaceTabOrder(workspaceId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;
  for (const leaf of allLeaves(layout.root)) normalizeGroupTabOrder(workspaceId, leaf.id);
}

/**
 * Pins or unpins a tab. As in VS Code, a newly pinned tab becomes the last
 * pinned tab and an unpinned one the first unpinned tab.
 */
export function toggleTabPin(workspaceId: string, tabId: string): void {
  useTabsStore.getState().togglePin(workspaceId, tabId);
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const leaf = layout ? allLeaves(layout.root).find((l) => l.tabIds.includes(tabId)) : undefined;
  if (!leaf) return;
  const isPinned = pinnedLookup(workspaceId);
  const others = pinnedFirst(
    leaf.tabIds.filter((id) => id !== tabId),
    isPinned,
  );
  const boundary = others.filter(isPinned).length;
  others.splice(boundary, 0, tabId);
  useLayoutStore.getState().setGroupTabOrder(workspaceId, leaf.id, others);
}
