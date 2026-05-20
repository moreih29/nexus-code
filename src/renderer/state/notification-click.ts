// Renderer-side handler for OS notification clicks emitted by the main process.
// Activates the target workspace and reveals the specific tab in the layout.

import { ipcListen } from "../ipc/client";
import { useActiveStore } from "./stores/active";
import { allLeaves } from "./stores/layout/helpers";
import { useLayoutStore } from "./stores/layout/store";

/**
 * Installs the `pty:notificationClick` IPC listener. Call once from bootstrap.
 * Returns the unlisten function to call on teardown.
 */
export function startNotificationClickListener(): () => void {
  return ipcListen("pty", "notificationClick", ({ workspaceId, tabId }) => {
    // Activate the workspace in the renderer store.
    useActiveStore.getState().setActiveWorkspaceId(workspaceId);

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
