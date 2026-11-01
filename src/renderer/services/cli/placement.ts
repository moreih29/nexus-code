/**
 * Where a tab the nexus CLI opens goes. The command came from a terminal the
 * user may be watching, so a tab that is shown goes beside it, not over it.
 */

import { openTabInNewSplit } from "@/state/operations/tabs";
import { allLeaves } from "@/state/stores/layout/helpers";
import { useLayoutStore } from "@/state/stores/layout/store";
import { type CreateTabArgs, type Tab, useTabsStore } from "@/state/stores/tabs";
import type { CliPlacement } from "../../../shared/cli/ui";

export interface TabPlace {
  readonly groupId: string;
  readonly tabId: string;
}

/** The group holding `tabId` in a workspace's layout. */
export function groupOf(workspaceId: string, tabId: string): string | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;
  return allLeaves(layout.root).find((leaf) => leaf.tabIds.includes(tabId))?.id ?? null;
}

/** The tabs of a workspace that `match`, group by group. */
export function findTabs(workspaceId: string, match: (tab: Tab) => boolean): TabPlace[] {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const records = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  if (!layout) return [];
  const places: TabPlace[] = [];
  for (const leaf of allLeaves(layout.root)) {
    for (const tabId of leaf.tabIds) {
      const tab = records[tabId];
      if (tab && match(tab)) places.push({ groupId: leaf.id, tabId });
    }
  }
  return places;
}

/** Adds a new tab as the one its group shows, leaving the active group alone. */
function attachShown(workspaceId: string, groupId: string, args: CreateTabArgs): string {
  const tab = useTabsStore.getState().createTab(workspaceId, args);
  useLayoutStore.getState().attachTab(workspaceId, groupId, tab.id);
  return tab.id;
}

/**
 * Opens a new tab. In the background it goes behind the tab the caller's
 * group shows. Shown, it goes in the active group, unless that is the
 * caller's: then in another group, or in a new one split off to the right,
 * so the caller's terminal stays in view.
 */
export function openTab(workspaceId: string, args: CreateTabArgs, placement: CliPlacement): string {
  useLayoutStore.getState().ensureLayout(workspaceId);
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) throw new Error(`layout slice not found for ${workspaceId}`);
  const callerGroup = placement.besideTabId ? groupOf(workspaceId, placement.besideTabId) : null;

  if (placement.background) {
    const groupId = callerGroup ?? layout.activeGroupId;
    const shown = allLeaves(layout.root).find((leaf) => leaf.id === groupId)?.activeTabId;
    const tab = useTabsStore.getState().createTab(workspaceId, args);
    const store = useLayoutStore.getState();
    store.attachTab(workspaceId, groupId, tab.id);
    // Attaching shows the tab; the group goes back to what it showed.
    if (shown) {
      store.setActiveTabInGroup({ workspaceId, groupId, tabId: shown, activateGroup: false });
    }
    return tab.id;
  }
  if (callerGroup === null || callerGroup !== layout.activeGroupId) {
    return attachShown(workspaceId, layout.activeGroupId, args);
  }
  const other = allLeaves(layout.root).find((leaf) => leaf.id !== callerGroup);
  if (other) return attachShown(workspaceId, other.id, args);
  const { tabId } = openTabInNewSplit(workspaceId, args, "horizontal", "after");
  useLayoutStore.getState().setActiveGroup(workspaceId, callerGroup);
  return tabId;
}

/**
 * Shows a tab that is already open in place of a new one, when one is open
 * outside the caller's group (showing one inside it would hide the caller).
 * Null when there is none.
 */
export function showOpenTab(
  workspaceId: string,
  places: readonly TabPlace[],
  placement: CliPlacement,
): string | null {
  const callerGroup = placement.besideTabId ? groupOf(workspaceId, placement.besideTabId) : null;
  const place = placement.background
    ? places[0]
    : places.find((candidate) => candidate.groupId !== callerGroup);
  if (!place) return null;
  if (!placement.background) {
    useLayoutStore.getState().setActiveTabInGroup({
      workspaceId,
      groupId: place.groupId,
      tabId: place.tabId,
      activateGroup: false,
    });
  }
  useTabsStore.getState().promoteFromPreview(workspaceId, place.tabId);
  return place.tabId;
}
