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
import { confirmAndDeletePath } from "../../services/fs-mutations";
import { handleCopy, handleCut, handlePaste } from "../../services/file-clipboard";
import { showToast } from "../../components/ui/toast";
import { refresh } from "../../state/operations/files";
import { openNewUntitledTab } from "../../state/operations/tabs";
import { useActiveStore } from "../../state/stores/active";
import { useFilesStore } from "../../state/stores/files";
import { useTabsStore } from "../../state/stores/tabs";
import { getActiveTabContext } from "../context";

export function registerFileCommands(): Array<() => void> {
  return [
    // ⌘N — open a new untitled buffer in the active workspace's active
    // group. No-op when no workspace is active so the shortcut never
    // surfaces a confusing error state. Mirrors VSCode's File ▸ New File.
    registerCommand(COMMANDS.fileNew, () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      openNewUntitledTab(wsId);
    }),

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

    // F2 — 파일트리 포커스 상태에서 현재 행의 인라인 rename 진입.
    // activeAbsPath가 루트이거나 없으면 no-op. rename 입력창이 열린 상태에서는
    // when:"!inputFocus" 조건이 막아 이 핸들러까지 도달하지 않는다.
    registerCommand(COMMANDS.fileRename, () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      const filesState = useFilesStore.getState();
      const path = filesState.activeAbsPath.get(wsId);
      if (!path) return;
      // 워크스페이스 루트는 rename 불가 (startRename 내부와 동일한 guard)
      const tree = filesState.trees.get(wsId);
      const rootAbsPath = tree?.rootAbsPath;
      if (path === rootAbsPath) return;
      filesState.requestRename(path);
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

    // File clipboard — copy/cut/paste scoped to file-tree focus.
    // wsId is validated inside handleCopy/handleCut; handlePaste is self-contained.
    registerCommand(COMMANDS.fileCopy, () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      const filesState = useFilesStore.getState();
      const tree = filesState.trees.get(wsId);
      if (!tree) return;
      const absPath = filesState.activeAbsPath.get(wsId);
      if (!absPath || absPath === tree.rootAbsPath) return;
      const node = tree.nodes.get(absPath);
      if (!node) return;
      handleCopy({
        workspaceId: wsId,
        workspaceRootPath: tree.rootAbsPath,
        entries: [{ relPath: absPath.slice(tree.rootAbsPath.length + 1), absPath }],
      });
    }),
    registerCommand(COMMANDS.fileCut, () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      const filesState = useFilesStore.getState();
      const tree = filesState.trees.get(wsId);
      if (!tree) return;
      const absPath = filesState.activeAbsPath.get(wsId);
      if (!absPath || absPath === tree.rootAbsPath) return;
      const node = tree.nodes.get(absPath);
      if (!node) return;
      handleCut({
        workspaceId: wsId,
        workspaceRootPath: tree.rootAbsPath,
        entries: [{ relPath: absPath.slice(tree.rootAbsPath.length + 1), absPath }],
      });
    }),
    registerCommand(COMMANDS.filePaste, () => {
      handlePaste().catch(() => {});
    }),
    registerCommand(COMMANDS.fileMoveHere, () => {
      handlePaste().catch(() => {});
    }),
    // Enter-triggered rename — Mac only (scoped by when: "isMac").
    registerCommand(COMMANDS.fileRenameByEnter, () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      const filesState = useFilesStore.getState();
      const path = filesState.activeAbsPath.get(wsId);
      if (!path) return;
      const tree = filesState.trees.get(wsId);
      if (!tree || path === tree.rootAbsPath) return;
      filesState.requestRename(path);
    }),

    // Delete / Backspace — 파일트리 포커스 상태에서 현재 행 삭제.
    // when:"fileTreeFocus && !inputFocus" 조건이 dispatcher 레벨에서 edit-row
    // 입력 중 발화를 막는다. 핸들러에서도 root / missing-node guard를 유지한다.
    registerCommand(COMMANDS.fileDelete, () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      const filesState = useFilesStore.getState();
      const absPath = filesState.activeAbsPath.get(wsId);
      if (!absPath) return;
      const tree = filesState.trees.get(wsId);
      if (!tree) return;
      // 워크스페이스 루트는 삭제 불가
      if (absPath === tree.rootAbsPath) return;
      const node = tree.nodes.get(absPath);
      if (!node) return;
      confirmAndDeletePath(wsId, tree.rootAbsPath, absPath, node.type).catch(() => {});
    }),
  ];
}
