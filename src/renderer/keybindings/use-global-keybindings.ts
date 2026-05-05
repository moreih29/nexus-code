import { useEffect } from "react";
import { Grid } from "../engine/split";
import { ipcCall } from "../ipc/client";
import { closeEditorWithConfirm, openOrRevealEditor, saveModel } from "../services/editor";
import { createPathActions } from "../services/fs-mutations";
import { closeTerminal, openTerminal } from "../services/terminal";
import { closeGroup } from "../state/operations";
import { useActiveStore } from "../state/stores/active";
import { useFilesStore } from "../state/stores/files";
import { useLayoutStore } from "../state/stores/layout";
import { type EditorTabProps, type TerminalTabProps, useTabsStore } from "../state/stores/tabs";
import { useWorkspacesStore } from "../state/stores/workspaces";
import { handleGlobalKeyDown } from "./global";

/**
 * Resolve the active group's currently focused tab. Returns null if any
 * link in the chain is missing (no workspace, no layout, empty group).
 * Each handler call re-resolves through the live stores so the result
 * tracks user navigation without rewiring the global listener.
 */
function getActiveTabContext():
  | { wsId: string; leaf: { id: string; tabIds: string[] }; tabId: string }
  | null {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return null;
  const layout = useLayoutStore.getState().byWorkspace[wsId];
  if (!layout) return null;
  const activeLeaf = Grid.findLeaf(layout.root, layout.activeGroupId);
  if (!activeLeaf?.activeTabId) return null;
  return { wsId, leaf: activeLeaf, tabId: activeLeaf.activeTabId };
}

function getWorkspaceRootPath(workspaceId: string): string | null {
  return (
    useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null
  );
}

/**
 * Build the path-action trio anchored to the currently active editor.
 * Returns null when there is no active editor (or no workspace), so the
 * caller can no-op without each shortcut handler re-walking the chain.
 * The resolver re-reads the tab on each invocation — by the time the
 * user hits the key the active tab might have changed.
 */
function getActiveEditorPathActions() {
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
      return (cur.props as EditorTabProps).filePath;
    },
  });
}

async function closeTabById(workspaceId: string, tabId: string): Promise<"closed" | "cancelled"> {
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

/**
 * Wires the global keydown listener on `window` and dispatches via
 * `handleGlobalKeyDown`. Every dependency is resolved through the live store
 * state at handler time, so this hook can stay mounted for the entire app
 * lifetime without re-binding when active workspace changes.
 */
export function useGlobalKeybindings(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      handleGlobalKeyDown(e, {
        getActiveWorkspaceId: () => useActiveStore.getState().activeWorkspaceId,
        refresh: (wsId) => useFilesStore.getState().refresh(wsId),
        openFileDialog: async (wsId) => {
          const { canceled, filePaths } = await ipcCall("dialog", "showOpenFile", {
            title: "Open File",
            filters: [
              { name: "TypeScript / JavaScript", extensions: ["ts", "tsx", "js", "jsx"] },
              { name: "All Files", extensions: ["*"] },
            ],
          });
          if (canceled || filePaths.length === 0) return;
          openOrRevealEditor({ workspaceId: wsId, filePath: filePaths[0] });
        },

        splitActiveGroup: (orientation) => {
          const wsId = useActiveStore.getState().activeWorkspaceId;
          if (!wsId) return;
          const layout = useLayoutStore.getState().byWorkspace[wsId];
          if (!layout) return;
          const activeLeaf = Grid.findLeaf(layout.root, layout.activeGroupId);
          if (!activeLeaf?.activeTabId) return;
          const tab = useTabsStore.getState().byWorkspace[wsId]?.[activeLeaf.activeTabId];
          if (!tab) return;

          if (tab.type === "editor") {
            openOrRevealEditor(tab.props as EditorTabProps, {
              newSplit: { orientation, side: "after" },
            });
            return;
          }

          if (tab.type === "terminal") {
            const props = tab.props as TerminalTabProps;
            openTerminal(
              { workspaceId: wsId, cwd: props.cwd },
              { groupId: activeLeaf.id, newSplit: { orientation, side: "after" } },
            );
          }
        },

        closeActiveGroup: () => {
          const wsId = useActiveStore.getState().activeWorkspaceId;
          if (!wsId) return;
          const layout = useLayoutStore.getState().byWorkspace[wsId];
          if (!layout) return;
          closeGroup(wsId, layout.activeGroupId);
        },

        saveActiveEditor: () => {
          const wsId = useActiveStore.getState().activeWorkspaceId;
          if (!wsId) return;
          const layout = useLayoutStore.getState().byWorkspace[wsId];
          if (!layout) return;
          const activeLeaf = Grid.findLeaf(layout.root, layout.activeGroupId);
          const tabId = activeLeaf?.activeTabId;
          if (!tabId) return;
          const tab = useTabsStore.getState().byWorkspace[wsId]?.[tabId];
          if (!tab || tab.type !== "editor") return;
          const props = tab.props as EditorTabProps;
          saveModel({ workspaceId: wsId, filePath: props.filePath }).catch(() => {});
        },

        closeActiveTab: () => {
          const ctx = getActiveTabContext();
          if (!ctx) return;
          void closeTabById(ctx.wsId, ctx.tabId);
        },

        closeOthersInActiveGroup: async () => {
          const ctx = getActiveTabContext();
          if (!ctx) return;
          // Pin protection mirrors `useGroupActions.closeOthers` —
          // pinned tabs aren't swept up by bulk-close gestures.
          const wsRecord = useTabsStore.getState().byWorkspace[ctx.wsId] ?? {};
          const others = ctx.leaf.tabIds.filter(
            (id) => id !== ctx.tabId && !wsRecord[id]?.isPinned,
          );
          for (const id of others) {
            const outcome = await closeTabById(ctx.wsId, id);
            if (outcome === "cancelled") return;
          }
        },

        revealActiveFile: () => {
          getActiveEditorPathActions()?.revealInFinder();
        },

        copyActivePath: () => {
          getActiveEditorPathActions()?.copyPath();
        },

        copyActiveRelativePath: () => {
          getActiveEditorPathActions()?.copyRelativePath();
        },

        moveFocus: (direction) => {
          const wsId = useActiveStore.getState().activeWorkspaceId;
          if (!wsId) return;
          const layout = useLayoutStore.getState().byWorkspace[wsId];
          if (!layout) return;

          const leaves = Grid.allLeaves(layout.root);
          if (leaves.length <= 1) return;

          const currentIdx = leaves.findIndex((l) => l.id === layout.activeGroupId);
          if (currentIdx === -1) return;

          let nextIdx: number;
          if (direction === "left" || direction === "up") {
            nextIdx = currentIdx > 0 ? currentIdx - 1 : leaves.length - 1;
          } else {
            nextIdx = currentIdx < leaves.length - 1 ? currentIdx + 1 : 0;
          }

          const nextLeaf = leaves[nextIdx];
          if (nextLeaf) {
            useLayoutStore.getState().setActiveGroup(wsId, nextLeaf.id);
          }
        },
      });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
