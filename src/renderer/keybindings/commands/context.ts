/**
 * Shared context resolvers used by every command-domain registrar.
 *
 * Each handler re-resolves the active group, tab, and workspace through
 * the live stores so user navigation tracks without rewiring the global
 * listener. Pulling these out of the registrar keeps each domain module
 * focused on the commands it owns.
 */

import { Grid } from "../../engine/split";
import { closeEditorWithConfirm } from "../../services/editor";
import { createPathActions } from "../../services/fs-mutations";
import { closeTerminal } from "../../services/terminal";
import { useActiveStore } from "../../state/stores/active";
import { useLayoutStore } from "../../state/stores/layout";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";

export interface ActiveTabContext {
  wsId: string;
  leaf: { id: string; tabIds: string[] };
  tabId: string;
}

export function getActiveTabContext(): ActiveTabContext | null {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return null;
  const layout = useLayoutStore.getState().byWorkspace[wsId];
  if (!layout) return null;
  const activeLeaf = Grid.findLeaf(layout.root, layout.activeGroupId);
  if (!activeLeaf?.activeTabId) return null;
  return { wsId, leaf: activeLeaf, tabId: activeLeaf.activeTabId };
}

export function getWorkspaceRootPath(workspaceId: string): string | null {
  return (
    useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null
  );
}

/**
 * Build the path-action trio anchored to the currently active editor.
 * Returns null when there is no active editor (or no workspace), so the
 * caller can no-op without each shortcut handler re-walking the chain.
 */
export function getActiveEditorPathActions() {
  const ctx = getActiveTabContext();
  if (!ctx) return null;
  const root = getWorkspaceRootPath(ctx.wsId);
  if (!root) return null;
  return createPathActions({
    workspaceId: ctx.wsId,
    workspaceRootPath: root,
    getAbsPath: () => {
      const cur = useTabsStore.getState().byWorkspace[ctx.wsId]?.[ctx.tabId];
      if (!cur || cur.type !== "editor") return null;
      return cur.props.filePath;
    },
  });
}

/**
 * Close one tab through the type-appropriate dirty-aware path.
 * Returned outcome lets bulk-close callers honour cancel.
 */
export async function closeTabById(
  workspaceId: string,
  tabId: string,
): Promise<"closed" | "cancelled"> {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!tab) return "closed";
  if (tab.type === "terminal") {
    closeTerminal(tabId);
    return "closed";
  }
  if (tab.type === "editor") {
    const outcome = await closeEditorWithConfirm(workspaceId, tabId);
    return outcome === "cancelled" ? "cancelled" : "closed";
  }
  return "closed";
}
