// Renderer-side handler for OS notification clicks emitted by the main process.
// Reveals the tab in the current view or its workspace.

import { ipcListen } from "../ipc/client";
import { showInAgentView } from "../services/agent-view/show";
import { focusWorkspace } from "./operations/workspace-selection";
import { useAgentViewStore } from "./stores/agent-view";
import { allLeaves } from "./stores/layout/helpers";
import { useLayoutStore } from "./stores/layout/store";
import { useTabsStore } from "./stores/tabs";

/**
 * Installs the `pty:notificationClick` IPC listener. Call once from bootstrap.
 * Returns the unlisten function to call on teardown.
 */
export function startNotificationClickListener(): () => void {
  return ipcListen("pty", "notificationClick", ({ workspaceId, tabId }) => {
    // The agent view shows an agent's conversation where it is; anything
    // else is shown in its workspace.
    const agentView = useAgentViewStore.getState();
    if (agentView.mode === "agents") {
      const type = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId]?.type;
      if (type === "claude" || type === "codex" || type === "terminal") {
        showInAgentView(workspaceId, tabId);
        return;
      }
    }

    focusWorkspace(workspaceId, "workspace");

    // Reveal the tab in whichever leaf group contains it.
    const layout = useLayoutStore.getState().byWorkspace[workspaceId];
    if (!layout) return;

    for (const leaf of allLeaves(layout.root)) {
      if (leaf.tabIds.includes(tabId)) {
        useLayoutStore.getState().setActiveTabInGroup({
          workspaceId,
          groupId: leaf.id,
          tabId,
          activateGroup: true,
        });
        return;
      }
    }
    // Tab not found in layout (may have been closed) — workspace activation
    // above is sufficient.
  });
}
