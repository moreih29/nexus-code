import i18next from "i18next";
import { toSlashPath } from "../../../shared/fs/drive-path";
import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { activeLocalPanelTab } from "../../services/agent-view/show";
import { openOrRevealEditor, runSaveAndReport } from "../../services/editor";
import { saveUntitledModel } from "../../services/editor/save/save-untitled-handler";
import { workingFileOfDiff } from "../../services/editor/tabs";
import { openExternalEditor } from "../../services/editor/tabs/open-external-editor";
import { handleCopy, handleCut, handlePaste } from "../../services/file-clipboard";
import { confirmAndDeleteBatch } from "../../services/fs-mutations";
import { refresh } from "../../state/operations/files";
import { openNewUntitledTab } from "../../state/operations/tabs";
import { useActiveStore } from "../../state/stores/active";
import { isAgentViewShown } from "../../state/stores/agent-view";
import {
  selectFocus,
  selectOperablePaths,
  useFilesStore,
  type WorkspaceTree,
} from "../../state/stores/files";
import { useTabsStore } from "../../state/stores/tabs";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { fsErrorReason } from "../../utils/file-error";
import { isWithinWorkspace, relPath } from "../../utils/path";
import { getActiveTabContext } from "../context";

type ClipboardEntry = { relPath: string; absPath: string };

function withFocusedTreePaths(
  handler: (ctx: {
    wsId: string;
    tree: WorkspaceTree;
    absPaths: readonly string[];
    entries: ClipboardEntry[];
  }) => void,
): void {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return;
  const filesState = useFilesStore.getState();
  const tree = filesState.trees.get(wsId);
  if (!tree) return;
  const absPaths = selectOperablePaths(filesState, wsId).filter(
    (p) => p !== tree.rootAbsPath && tree.nodes.has(p),
  );
  if (absPaths.length === 0) return;
  const entries = absPaths.map((p) => ({
    relPath: relPath(p, tree.rootAbsPath),
    absPath: p,
  }));
  handler({ wsId, tree, absPaths, entries });
}

function withFocusedSinglePath(
  handler: (ctx: { wsId: string; tree: WorkspaceTree; path: string }) => void,
): void {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return;
  const filesState = useFilesStore.getState();
  const path = selectFocus(filesState, wsId);
  if (!path) return;
  const tree = filesState.trees.get(wsId);
  if (!tree || path === tree.rootAbsPath) return;
  handler({ wsId, tree, path });
}

function makeClipboardCommand(
  action: typeof handleCopy | typeof handleCut,
  doneKey: "files:fileTree.clipboard.copied" | "files:fileTree.clipboard.cut",
): () => void {
  return () => {
    withFocusedTreePaths(({ wsId, tree, entries }) => {
      action({ workspaceId: wsId, workspaceRootPath: tree.rootAbsPath, entries });
      if (entries.length >= 2) {
        showToast({ kind: "info", message: i18next.t(doneKey, { count: entries.length }) });
      }
    });
  };
}

export function registerFileCommands(): Array<() => void> {
  return [
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
      const path = selectFocus(useFilesStore.getState(), wsId);
      if (!path) return;
      const tree = useFilesStore.getState().trees.get(wsId);
      const node = tree?.nodes.get(path);
      if (!node || node.type !== "file") return;
      openOrRevealEditor(
        { workspaceId: wsId, filePath: path },
        { newSplit: { orientation: "horizontal", side: "after" } },
      );
    }),

    registerCommand(COMMANDS.fileRename, () => {
      withFocusedSinglePath(({ path }) => {
        useFilesStore.getState().requestRename(path);
      });
    }),

    registerCommand(COMMANDS.fileOpen, async () => {
      const wsId = useActiveStore.getState().activeWorkspaceId;
      if (!wsId) return;
      const { canceled, filePaths } = unwrapIpcResult(
        await ipcCallResult("dialog", "showOpenFile", {}),
      );
      if (canceled || filePaths.length === 0) return;
      const filePath = toSlashPath(filePaths[0]);
      const rootPath = useWorkspacesStore
        .getState()
        .workspaces.find((w) => w.id === wsId)?.rootPath;
      if (rootPath && !isWithinWorkspace(filePath, rootPath)) {
        openExternalEditor({ workspaceId: wsId, filePath });
        return;
      }
      openOrRevealEditor({ workspaceId: wsId, filePath });
    }),

    registerCommand(COMMANDS.fileSave, () => {
      if (isAgentViewShown()) {
        const active = activeLocalPanelTab();
        if (active?.tab.type === "editor") runSaveAndReport(active.tab.props);
        return;
      }
      const ctx = getActiveTabContext();
      if (!ctx) return;
      const tab = useTabsStore.getState().byWorkspace[ctx.wsId]?.[ctx.tabId];
      if (!tab) return;
      if (tab.type === "untitled") {
        saveUntitledModel(ctx.wsId, ctx.tabId).catch((error: unknown) => {
          showToast({
            kind: "error",
            message: i18next.t("errors:save.failed", { reason: fsErrorReason(error) }),
          });
        });
        return;
      }
      const filePath =
        tab.type === "editor"
          ? tab.props.filePath
          : tab.type === "editor.diff"
            ? workingFileOfDiff(tab.props)
            : null;
      if (filePath === null) return;
      runSaveAndReport({ workspaceId: ctx.wsId, filePath });
    }),

    registerCommand(
      COMMANDS.fileCopy,
      makeClipboardCommand(handleCopy, "files:fileTree.clipboard.copied"),
    ),
    registerCommand(
      COMMANDS.fileCut,
      makeClipboardCommand(handleCut, "files:fileTree.clipboard.cut"),
    ),
    registerCommand(COMMANDS.filePaste, () => {
      handlePaste().catch(() => {});
    }),
    registerCommand(COMMANDS.fileMoveHere, () => {
      handlePaste().catch(() => {});
    }),
    registerCommand(COMMANDS.fileRenameByEnter, () => {
      withFocusedSinglePath(({ path }) => {
        useFilesStore.getState().requestRename(path);
      });
    }),

    registerCommand(COMMANDS.fileDelete, () => {
      withFocusedTreePaths(({ wsId, tree, absPaths }) => {
        confirmAndDeleteBatch(wsId, tree.rootAbsPath, absPaths).catch(() => {});
      });
    }),
  ];
}
