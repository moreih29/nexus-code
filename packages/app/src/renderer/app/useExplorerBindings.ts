import { useCallback, useMemo } from "react";

import type { WorkspaceFileKind } from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { FileExternalDragInRequest, FileExternalDragInResult } from "../../common/file-actions";
import type { FileTreeContextMenuActionPayload } from "../components/file-tree-context-menu";
import type { EditorDocumentsServiceStore } from "../services/editor-documents-service";
import type { EditorGroupsServiceStore } from "../services/editor-groups-service";
import type { EditorPaneId } from "../services/editor-types";
import type { FilesServiceStore, FilesTreeSelectionMovement } from "../services/files-service";
import type { GitServiceStore } from "../services/git-service";
import type { WorkspaceServiceStore } from "../services/workspace-service";
import type { FileClipboardItem, FileClipboardStore } from "../stores/file-clipboard-store";
import { refreshEditorFileTreeAndGitBadges, syncGitBadgesFromFiles } from "./wiring";
import {
  openEditorDiffInServices,
  openEditorFileInServices,
  removeEditorTabsForDeletedPath,
  renameEditorDocumentsAndTabs,
  runEditorMutation,
  runFileActionMutation,
  splitEditorPaneRightInGroups,
} from "./useEditorBindings";

export interface UseExplorerBindingsInput {
  activeWorkspaceId: WorkspaceId | null;
  documentsService: EditorDocumentsServiceStore;
  fileClipboardStore: FileClipboardStore;
  filesService: FilesServiceStore;
  gitService: GitServiceStore;
  groupsService: EditorGroupsServiceStore;
  showTerminalPanel: () => void;
  workspaceService: WorkspaceServiceStore;
}

export interface ExplorerBindings {
  beginCreateFile(parentPath?: string | null): void;
  beginCreateFolder(parentPath?: string | null): void;
  beginDelete(path: string, kind: WorkspaceFileKind): void;
  beginRename(path: string, kind: WorkspaceFileKind): void;
  cancelClipboardCollision(): void;
  cancelExplorerEdit(): void;
  collapseAll(workspaceId?: WorkspaceId): void;
  compareFiles(leftPath: string, rightPath: string): void;
  copyClipboardItems(items: FileClipboardItem[]): void;
  copyExternalFilesIntoTree(request: FileExternalDragInRequest): Promise<FileExternalDragInResult>;
  copyPath(payload: FileTreeContextMenuActionPayload, pathKind: "absolute" | "relative"): void;
  createNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): void;
  cutClipboardItems(items: FileClipboardItem[]): void;
  deleteNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): void;
  moveTreeSelection(movement: FilesTreeSelectionMovement): void;
  openFile(workspaceId: WorkspaceId, path: string): void;
  openFileToSide(workspaceId: WorkspaceId, path: string): void;
  openInTerminal(payload: FileTreeContextMenuActionPayload): void;
  openWithSystemApp(payload: FileTreeContextMenuActionPayload): void;
  pasteClipboardItems(payload: FileTreeContextMenuActionPayload): void;
  refresh(workspaceId: WorkspaceId): void;
  renameNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): void;
  resolveClipboardCollision(strategy: "replace" | "keep-both" | "skip"): void;
  resolveExternalFilePath(file: File): string;
  revealInFinder(payload: FileTreeContextMenuActionPayload): void;
  selectTreePath(path: string | null): void;
  startFileDrag(workspaceId: WorkspaceId, paths: string[]): void;
  toggleDirectory(path: string): void;
}

export function useExplorerBindings({
  activeWorkspaceId,
  documentsService,
  fileClipboardStore,
  filesService,
  gitService,
  groupsService,
  showTerminalPanel,
  workspaceService,
}: UseExplorerBindingsInput): ExplorerBindings {
  const refreshEditorFileTree = useCallback(async (workspaceId?: WorkspaceId | null) => {
    await refreshEditorFileTreeAndGitBadges(filesService, gitService, workspaceId);
  }, [filesService, gitService]);

  const refresh = useCallback((workspaceId: WorkspaceId) => {
    void runEditorMutation(() => refreshEditorFileTree(workspaceId));
  }, [refreshEditorFileTree]);

  const toggleDirectory = useCallback((path: string) => {
    filesService.getState().toggleDirectory(path);
  }, [filesService]);

  const selectTreePath = useCallback((path: string | null) => {
    filesService.getState().selectPath(path);
  }, [filesService]);

  const beginCreateFile = useCallback((parentPath?: string | null) => {
    filesService.getState().beginCreateFile(parentPath);
  }, [filesService]);

  const beginCreateFolder = useCallback((parentPath?: string | null) => {
    filesService.getState().beginCreateFolder(parentPath);
  }, [filesService]);

  const beginRename = useCallback((path: string, kind: WorkspaceFileKind) => {
    filesService.getState().beginRename(path, kind);
  }, [filesService]);

  const beginDelete = useCallback((path: string, kind: WorkspaceFileKind) => {
    filesService.getState().beginDelete(path, kind);
  }, [filesService]);

  const cancelExplorerEdit = useCallback(() => {
    filesService.getState().cancelExplorerEdit();
  }, [filesService]);

  const collapseAll = useCallback(() => {
    filesService.getState().collapseAll();
  }, [filesService]);

  const moveTreeSelection = useCallback((movement: FilesTreeSelectionMovement) => {
    filesService.getState().moveTreeSelection(movement);
  }, [filesService]);

  const openFile = useCallback((workspaceId: WorkspaceId, path: string) => {
    void runEditorMutation(() => openEditorFileInServices({
      documentsService,
      filesService,
      groupsService,
      workspaceService,
      workspaceId,
      path,
    }));
  }, [documentsService, filesService, groupsService, workspaceService]);

  const openFileToSide = useCallback((workspaceId: WorkspaceId, path: string) => {
    void runEditorMutation(async () => {
      splitEditorPaneRightInGroups(groupsService);
      await openEditorFileInServices({
        documentsService,
        filesService,
        groupsService,
        workspaceService,
        workspaceId,
        path,
      });
    });
  }, [documentsService, filesService, groupsService, workspaceService]);

  const createNode = useCallback((workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind) => {
    void runEditorMutation(async () => {
      await filesService.getState().createFileNode(workspaceId, path, kind);
      syncGitBadgesFromFiles(filesService, gitService, workspaceId);
    });
  }, [filesService, gitService]);

  const deleteNode = useCallback((workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind) => {
    void runEditorMutation(async () => {
      const result = await filesService.getState().deleteFileNode(workspaceId, path, kind);
      removeEditorTabsForDeletedPath(groupsService, documentsService, workspaceId, result.path, kind);
      syncGitBadgesFromFiles(filesService, gitService, workspaceId);
    });
  }, [documentsService, filesService, gitService, groupsService]);

  const renameNode = useCallback((workspaceId: WorkspaceId, oldPath: string, newPath: string) => {
    void runEditorMutation(async () => {
      const result = await filesService.getState().renameFileNode(workspaceId, oldPath, newPath);
      renameEditorDocumentsAndTabs(groupsService, documentsService, workspaceId, result.oldPath, result.newPath);
      syncGitBadgesFromFiles(filesService, gitService, workspaceId);
    });
  }, [documentsService, filesService, gitService, groupsService]);

  const compareFiles = useCallback((leftPath: string, rightPath: string) => {
    if (!activeWorkspaceId) {
      return;
    }

    void runEditorMutation(() =>
      openEditorDiffInServices(
        documentsService,
        groupsService,
        workspaceService,
        { workspaceId: activeWorkspaceId, path: leftPath },
        { workspaceId: activeWorkspaceId, path: rightPath },
        { source: "compare" },
      ),
    );
  }, [activeWorkspaceId, documentsService, groupsService, workspaceService]);

  const revealInFinder = useCallback((payload: FileTreeContextMenuActionPayload) => {
    void runFileActionMutation(() =>
      window.nexusFileActions.invoke({
        type: "file-actions/reveal-in-finder",
        workspaceId: payload.workspaceId,
        path: payload.path,
      }),
    );
  }, []);

  const openWithSystemApp = useCallback((payload: FileTreeContextMenuActionPayload) => {
    void runFileActionMutation(() =>
      window.nexusFileActions.invoke({
        type: "file-actions/open-with-system-app",
        workspaceId: payload.workspaceId,
        path: payload.path,
      }),
    );
  }, []);

  const openInTerminal = useCallback((payload: FileTreeContextMenuActionPayload) => {
    void runFileActionMutation(async () => {
      await window.nexusFileActions.invoke({
        type: "file-actions/open-in-terminal",
        workspaceId: payload.workspaceId,
        path: payload.path,
        kind: payload.kind,
      });
      showTerminalPanel();
    });
  }, [showTerminalPanel]);

  const copyPath = useCallback((
    payload: FileTreeContextMenuActionPayload,
    pathKind: "absolute" | "relative",
  ) => {
    void runFileActionMutation(() =>
      window.nexusFileActions.invoke({
        type: "file-actions/copy-path",
        workspaceId: payload.workspaceId,
        path: payload.path,
        pathKind,
      }),
    );
  }, []);

  const pasteClipboardItems = useCallback((payload: FileTreeContextMenuActionPayload) => {
    void runFileActionMutation(async () => {
      const result = await fileClipboardStore.getState().paste({
        workspaceId: payload.workspaceId,
        targetDirectory: payload.targetDirectory,
      });
      if (result && result.collisions.length === 0) {
        await refreshEditorFileTree(payload.workspaceId);
      }
    });
  }, [fileClipboardStore, refreshEditorFileTree]);

  const resolveClipboardCollision = useCallback((strategy: "replace" | "keep-both" | "skip") => {
    void runFileActionMutation(async () => {
      const workspaceId = fileClipboardStore.getState().pendingCollision?.request.workspaceId ?? null;
      const result = await fileClipboardStore.getState().resolvePendingCollision(strategy);
      if (workspaceId && result && result.collisions.length === 0) {
        await refreshEditorFileTree(workspaceId);
      }
    });
  }, [fileClipboardStore, refreshEditorFileTree]);

  const copyExternalFilesIntoTree = useCallback(async (
    request: FileExternalDragInRequest,
  ): Promise<FileExternalDragInResult> => {
    const result = await window.nexusFileActions.invoke(request);
    if (result.type !== "file-actions/external-drag-in/result") {
      throw new Error("External file drop returned an unexpected result.");
    }
    if (result.collisions.length === 0) {
      await refreshEditorFileTree(request.workspaceId);
    }
    return result;
  }, [refreshEditorFileTree]);

  const startFileDrag = useCallback((workspaceId: WorkspaceId, paths: string[]) => {
    void runFileActionMutation(() =>
      window.nexusFileActions.startFileDrag({
        workspaceId,
        paths,
      }),
    );
  }, []);

  const cutClipboardItems = useCallback((items: FileClipboardItem[]) => {
    fileClipboardStore.getState().cut(items);
  }, [fileClipboardStore]);

  const copyClipboardItems = useCallback((items: FileClipboardItem[]) => {
    fileClipboardStore.getState().copy(items);
  }, [fileClipboardStore]);

  const cancelClipboardCollision = useCallback(() => {
    fileClipboardStore.getState().clearPendingCollision();
  }, [fileClipboardStore]);

  const resolveExternalFilePath = useCallback((file: File) => window.nexusFileActions.getPathForFile(file), []);

  return useMemo(() => ({
    beginCreateFile,
    beginCreateFolder,
    beginDelete,
    beginRename,
    cancelClipboardCollision,
    cancelExplorerEdit,
    collapseAll,
    compareFiles,
    copyClipboardItems,
    copyExternalFilesIntoTree,
    copyPath,
    createNode,
    cutClipboardItems,
    deleteNode,
    moveTreeSelection,
    openFile,
    openFileToSide,
    openInTerminal,
    openWithSystemApp,
    pasteClipboardItems,
    refresh,
    renameNode,
    resolveClipboardCollision,
    resolveExternalFilePath,
    revealInFinder,
    selectTreePath,
    startFileDrag,
    toggleDirectory,
  }), [
    beginCreateFile,
    beginCreateFolder,
    beginDelete,
    beginRename,
    cancelClipboardCollision,
    cancelExplorerEdit,
    collapseAll,
    compareFiles,
    copyClipboardItems,
    copyExternalFilesIntoTree,
    copyPath,
    createNode,
    cutClipboardItems,
    deleteNode,
    moveTreeSelection,
    openFile,
    openFileToSide,
    openInTerminal,
    openWithSystemApp,
    pasteClipboardItems,
    refresh,
    renameNode,
    resolveClipboardCollision,
    resolveExternalFilePath,
    revealInFinder,
    selectTreePath,
    startFileDrag,
    toggleDirectory,
  ]);
}
