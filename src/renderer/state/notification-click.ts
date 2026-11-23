import { ipcListen } from "../ipc/client";
import { showInAgentView } from "../services/agent-view/show";
import { focusWorkspace } from "./operations/workspace-selection";
import { useAgentViewStore } from "./stores/agent-view";
import { allLeaves } from "./stores/layout/helpers";
import { useLayoutStore } from "./stores/layout/store";
import { useTabsStore } from "./stores/tabs";

export function startNotificationClickListener(): () => void {
  return ipcListen("pty", "notificationClick", ({ workspaceId, tabId }) => {
    const agentView = useAgentViewStore.getState();
    if (agentView.mode === "agents") {
      const type = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId]?.type;
      if (type === "claude" || type === "codex" || type === "terminal") {
        showInAgentView(workspaceId, tabId);
        return;
      }
    }

    const layout = useLayoutStore.getState().byWorkspace[workspaceId];
    const group = layout && allLeaves(layout.root).find((leaf) => leaf.tabIds.includes(tabId));
    if (group) {
      useLayoutStore.getState().setActiveTabInGroup({
        workspaceId,
        groupId: group.id,
        tabId,
        activateGroup: true,
      });
    }
    focusWorkspace(workspaceId, "preserve");
    if (agentView.mode === "agents") agentView.setMode("workspace");
  });
}
