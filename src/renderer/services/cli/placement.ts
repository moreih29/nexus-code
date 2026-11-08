/**
 * Where a tab the nexus CLI opens goes. The command came from a terminal the
 * user may be watching, so a tab that is shown goes beside it, not over it.
 *
 * While the window shows the agent view, a session (a Claude or Codex tab,
 * a terminal) shows there; anything else shows in its workspace, the
 * window switching to the workspaces for it.
 */

import { openTabInNewSplit } from "@/state/operations/tabs";
import { useActiveStore } from "@/state/stores/active";
import { isAgentViewShown, useAgentViewStore } from "@/state/stores/agent-view";
import { allLeaves } from "@/state/stores/layout/helpers";
import { useLayoutStore } from "@/state/stores/layout/store";
import { type CreateTabArgs, type Tab, useTabsStore } from "@/state/stores/tabs";
import type { CliPlacement } from "../../../shared/cli/ui";
import { holdsInAgentView, isShownInAgentView, showBesideCaller } from "../agent-view/show";
import { requestTabFocus } from "../tab-focus";
import { activateWorkspace } from "../workspace/tasks";

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

/** The caller of a command whose placement names it, as a session. */
function callerOf(workspaceId: string, placement: CliPlacement) {
  return placement.besideTabId ? { workspaceId, tabId: placement.besideTabId } : null;
}

/**
 * Leaves the agent view for `workspaceId`, to show a tab there. A caller
 * the agent view showed comes to the front of its group, so what opens
 * goes beside it, and keeps the keyboard it had.
 */
export function leaveAgentView(workspaceId: string, callerTabId?: string): void {
  const callerShown =
    callerTabId !== undefined && isShownInAgentView(workspaceId, callerTabId) ? callerTabId : null;
  const callerGroup = callerShown !== null ? groupOf(workspaceId, callerShown) : null;
  if (callerShown !== null && callerGroup !== null) {
    useLayoutStore
      .getState()
      .setActiveTabInGroup({ workspaceId, groupId: callerGroup, tabId: callerShown });
  }
  if (useActiveStore.getState().activeWorkspaceId !== workspaceId) activateWorkspace(workspaceId);
  else useAgentViewStore.getState().setMode("workspace");
  if (callerShown !== null && callerGroup !== null) requestTabFocus(callerShown);
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
  if (!placement.background && isAgentViewShown()) {
    if (holdsInAgentView(args.type)) {
      const tabId = openTab(workspaceId, args, { ...placement, background: true });
      showBesideCaller(workspaceId, tabId, callerOf(workspaceId, placement));
      return tabId;
    }
    leaveAgentView(workspaceId, placement.besideTabId);
  }
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
  if (!placement.background && isAgentViewShown() && places[0]) {
    const { tabId } = places[0];
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (tab && holdsInAgentView(tab.type)) {
      showBesideCaller(workspaceId, tabId, callerOf(workspaceId, placement));
      useTabsStore.getState().promoteFromPreview(workspaceId, tabId);
      return tabId;
    }
    leaveAgentView(workspaceId, placement.besideTabId);
  }
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
