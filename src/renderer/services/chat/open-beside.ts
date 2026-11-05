// Opening what a Claude tab names as a tab of its own: in the group beside
// the Claude tab, split off when the tab is wide enough to share; in the
// Claude tab's own group when it is narrow and has no neighbour.

import { Grid } from "@/engine";
import { openBrowserTabAt, revealTab } from "../../state/operations/tabs";
import { useLayoutStore } from "../../state/stores/layout/store";
import { openOrRevealEditor } from "../editor";
import { openExternalEditor } from "../editor/tabs/open-external-editor";

/**
 * Makes the group the new tab goes in the active one: the group next to
 * the Claude tab's; with `split`, a new one when there is none; otherwise
 * the Claude tab's own.
 */
function activateTarget(workspaceId: string, claudeTabId: string, split: boolean): void {
  const store = useLayoutStore.getState();
  store.ensureLayout(workspaceId);
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;
  const leaves = Grid.allLeaves(layout.root);
  const at = leaves.findIndex((leaf) => leaf.tabIds.includes(claudeTabId));
  if (at < 0) return;
  const next = leaves[at + 1] ?? leaves[at - 1];
  if (next) store.setActiveGroup(workspaceId, next.id);
  // A new group becomes the active one.
  else if (split) store.splitGroup(workspaceId, leaves[at].id, "horizontal", "after");
  else store.setActiveGroup(workspaceId, leaves[at].id);
}

/** Opens a file in the editor; one outside the workspace opens read-only. */
export function openFileBeside(
  workspaceId: string,
  claudeTabId: string,
  path: string,
  opts: { split: boolean; inside: boolean },
): void {
  activateTarget(workspaceId, claudeTabId, opts.split);
  if (opts.inside) openOrRevealEditor({ workspaceId, filePath: path }, { preview: true });
  else openExternalEditor({ workspaceId, filePath: path });
}

/** Shows a tab of the workspace, wherever it is in the layout. */
export function revealTabById(workspaceId: string, tabId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  if (!layout) return;
  const leaf = Grid.allLeaves(layout.root).find((l) => l.tabIds.includes(tabId));
  if (leaf) revealTab(workspaceId, leaf.id, tabId);
}

/** Opens an address in the app's browser. */
export function openBrowserBeside(
  workspaceId: string,
  claudeTabId: string,
  url: string,
  opts: { split: boolean },
): void {
  activateTarget(workspaceId, claudeTabId, opts.split);
  openBrowserTabAt(workspaceId, url);
}
