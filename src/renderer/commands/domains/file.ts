/**
 * File-domain commands: open, save, refresh, open-to-side.
 *
 * `register()` returns the array of unregister callbacks so the hook
 * that mounts the global listener can compose them with the others.
 */

import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { openOrRevealEditor, runSaveAndReport } from "../../services/editor";
import { saveUntitledModel } from "../../services/editor/save/save-untitled-handler";
import { showToast } from "../../components/ui/toast";
import { refresh } from "../../state/operations/files";
import { useActiveStore } from "../../state/stores/active";
import { useFilesStore } from "../../state/stores/files";
import { useTabsStore } from "../../state/stores/tabs";
import { getActiveTabContext } from "../context";

export function registerFileCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.filesRefresh, () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      refresh(wsId).catch(() => {});
    }),

    registerCommand(COMMANDS.openToSide, () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      const path = useFilesStore.getState().activeAbsPath.get(wsId);
      if (!path) return;
      // Mirror the file-tree's local "open in side split" — the
      // explorer publishes the active row's absPath to the store so
      // this handler can act without seeing the tree's component
      // state. Directories are filtered here (not in the file-tree)
      // because the global dispatcher fires regardless of the row's
      // node type.
      const tree = useFilesStore.getState().trees.get(wsId);
      const node = tree?.nodes.get(path);
      if (!node || node.type !== "file") return;
      openOrRevealEditor(
        { workspaceId: wsId, filePath: path },
        { newSplit: { orientation: "horizontal", side: "after" } },
      );
    }),

    registerCommand(COMMANDS.fileOpen, async () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      const { canceled, filePaths } = unwrapIpcResult(
        await ipcCallResult("dialog", "showOpenFile", {
          title: "Open File",
          filters: [
            { name: "TypeScript / JavaScript", extensions: ["ts", "tsx", "js", "jsx"] },
            { name: "All Files", extensions: ["*"] },
          ],
        }),
      );
      if (canceled || filePaths.length === 0) return;
      openOrRevealEditor({ workspaceId: wsId, filePath: filePaths[0] });
    }),

    registerCommand(COMMANDS.fileSave, () => {
      const ctx = getActiveTabContext();
      if (!ctx) return;
      const tab = useTabsStore.getState().byWorkspace[ctx.wsId]?.[ctx.tabId];
      if (!tab) return;
      if (tab.type === "untitled") {
        saveUntitledModel(ctx.wsId, ctx.tabId).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          showToast({ kind: "error", message: `Save failed: ${message}` });
        });
        return;
      }
      if (tab.type !== "editor") return;
      runSaveAndReport({ workspaceId: ctx.wsId, filePath: tab.props.filePath });
    }),
  ];
}
