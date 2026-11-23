import { closeTab } from "@/state/operations/tabs";
import { useTabsStore } from "@/state/stores/tabs";

export function closeEditor(tabId: string): void {
  const byWorkspace = useTabsStore.getState().byWorkspace;
  for (const [workspaceId, tabs] of Object.entries(byWorkspace)) {
    if (tabs[tabId]?.type !== "editor") continue;
    closeTab(workspaceId, tabId);
    return;
  }
}
