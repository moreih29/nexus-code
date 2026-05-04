/**
 * Group lifecycle transactions.
 *
 * `closeGroup` is the only public entry today. It coordinates the layout
 * store's group removal with PTY session cleanup for any terminal tabs
 * the group owns — the PTY backend must die before the tab record is
 * removed, otherwise the orphan PTY keeps draining bytes into a dead
 * frontend. The order is enforced here rather than in the layout store
 * to keep the store oblivious to terminal lifecycle.
 */

import { killSession } from "@/services/terminal/pty-client";
import { useLayoutStore } from "../stores/layout";
import { findLeaf } from "../stores/layout/helpers";
import { useTabsStore } from "../stores/tabs";

/**
 * Close all tabs in a layout leaf and remove the leaf from the tree.
 * If the leaf is the sole leaf it is preserved as an empty placeholder.
 * All tab records belonging to the leaf are deleted from the tabs store.
 */
export function closeGroup(workspaceId: string, leafId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;

  const leaf = findLeaf(layout.root, leafId);
  if (!leaf) return;

  const ids = [...leaf.tabIds];
  const tabsById = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
  for (const tabId of ids) {
    // Temporary layer trade-off: group close is still a state transaction, but
    // terminal PTY records must die before terminal tab records are removed.
    if (tabsById[tabId]?.type === "terminal") {
      killSession(tabId);
    }
  }

  useLayoutStore.getState().closeGroup(workspaceId, leafId);

  for (const tabId of ids) {
    useTabsStore.getState().removeTab(workspaceId, tabId);
  }
}
