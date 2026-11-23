import { openTabInNewSplit } from "@/state/operations/tabs";
import { useActiveStore } from "@/state/stores/active";
import { isAgentViewShown, useAgentViewStore } from "@/state/stores/agent-view";
import { allLeaves } from "@/state/stores/layout/helpers";
import { useLayoutStore } from "@/state/stores/layout/store";
import { type CreateTabArgs, type Tab, useTabsStore } from "@/state/stores/tabs";
import type { CliPlacement } from "../../../shared/cli/ui";
import { activateWorkspace } from "../../state/operations/workspace-selection";
import { holdsInAgentView, isShownInAgentView, showBesideCaller } from "../agent-view/show";
import { requestTabFocus } from "../tab-focus";

export interface TabPlace {
  readonly groupId: string;
  readonly tabId: string;
}

export function groupOf(workspaceId: string, tabId: string): string | null {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return null;
  return allLeaves(layout.root).find((leaf) => leaf.tabIds.includes(tabId))?.id ?? null;
}

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

function callerOf(workspaceId: string, placement: CliPlacement) {
  return placement.besideTabId ? { workspaceId, tabId: placement.besideTabId } : null;
}

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

function attachShown(workspaceId: string, groupId: string, args: CreateTabArgs): string {
  const tab = useTabsStore.getState().createTab(workspaceId, args);
  useLayoutStore.getState().attachTab(workspaceId, groupId, tab.id);
  return tab.id;
}

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
