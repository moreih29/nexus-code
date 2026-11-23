import { useLayoutStore } from "../stores/layout";
import { allLeaves, findLeaf } from "../stores/layout/helpers";
import { useTabsStore } from "../stores/tabs";

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

export function normalizeGroupTabOrder(workspaceId: string, groupId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const leaf = layout ? findLeaf(layout.root, groupId) : null;
  if (!leaf) return;
  useLayoutStore
    .getState()
    .setGroupTabOrder(workspaceId, groupId, pinnedFirst(leaf.tabIds, pinnedLookup(workspaceId)));
}

export function normalizeWorkspaceTabOrder(workspaceId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;
  for (const leaf of allLeaves(layout.root)) normalizeGroupTabOrder(workspaceId, leaf.id);
}

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
