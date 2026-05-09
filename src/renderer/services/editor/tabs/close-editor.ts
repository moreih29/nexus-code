import { closeTab } from "@/state/operations/tabs";
import { useTabsStore } from "@/state/stores/tabs";

/**
 * Close an editor tab by tabId. Walks every workspace's tab record because
 * a tabId is globally unique but the close-tab operation is keyed by
 * (workspaceId, tabId). Returns silently when the id refers to something
 * other than an editor tab — terminal tabs go through their own service.
 */
export function closeEditor(tabId: string): void {
  const byWorkspace = useTabsStore.getState().byWorkspace;
  for (const [workspaceId, tabs] of Object.entries(byWorkspace)) {
    if (tabs[tabId]?.type !== "editor") continue;
    closeTab(workspaceId, tabId);
    return;
  }
}
