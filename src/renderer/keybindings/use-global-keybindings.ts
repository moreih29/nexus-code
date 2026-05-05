import { useEffect } from "react";
import { Grid } from "../engine/split";
import { ipcCall } from "../ipc/client";
import { openOrRevealEditor } from "../services/editor";
import { openTerminal } from "../services/terminal";
import { closeGroup } from "../state/operations";
import { useActiveStore } from "../state/stores/active";
import { useFilesStore } from "../state/stores/files";
import { useLayoutStore } from "../state/stores/layout";
import { type EditorTabProps, type TerminalTabProps, useTabsStore } from "../state/stores/tabs";
import { handleGlobalKeyDown } from "./global";

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
