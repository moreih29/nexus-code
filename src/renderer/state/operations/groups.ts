import { killSession } from "@/services/terminal/pty-client";
import { useLayoutStore } from "../stores/layout";
import { findLeaf } from "../stores/layout/helpers";
import { useTabsStore } from "../stores/tabs";

export function closeGroup(workspaceId: string, leafId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;

  const leaf = findLeaf(layout.root, leafId);
  if (!leaf) return;

  const ids = [...leaf.tabIds];
  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  for (const tabId of ids) {
    if (tabsById[tabId]?.type === "terminal") {
      killSession(workspaceId, tabId);
    }
  }

  useLayoutStore.getState().closeGroup(workspaceId, leafId);

  for (const tabId of ids) {
    useTabsStore.getState().removeTab(workspaceId, tabId);
  }
}
