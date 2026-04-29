import { FileTreePanel, type FileTreePanelProps } from "../components/FileTreePanel";
import type { AppShellBindings } from "./hooks/useAppShellBindings";
import type { AppShellState } from "./hooks/useAppShellState";

export type FileTreePanelContainerState = Pick<
  AppShellState,
  | "activeWorkspace"
  | "activeWorkspaceTabId"
  | "editorFileTree"
  | "editorExpandedPaths"
  | "editorGitBadgeByPath"
  | "editorSelectedTreePath"
  | "editorPendingExplorerEdit"
  | "editorPendingExplorerDelete"
  | "fileClipboardCanPaste"
  | "fileClipboardPendingCollision"
>;

export type FileTreePanelContainerBindings = Pick<
  AppShellBindings,
  "explorerBindings" | "sourceControlBindings"
>;

export interface FileTreePanelContainerProps {
  appState: FileTreePanelContainerState;
  bindings: FileTreePanelContainerBindings;
}

export function FileTreePanelContainer(props: FileTreePanelContainerProps): JSX.Element {
  return <FileTreePanel {...createFileTreePanelProps(props)} />;
}

export function createFileTreePanelProps({
  appState,
  bindings,
}: FileTreePanelContainerProps): FileTreePanelProps {
  const { explorerBindings, sourceControlBindings } = bindings;

  return {
    activeWorkspace: appState.activeWorkspace,
    workspaceTabId: appState.activeWorkspaceTabId,
    fileTree: appState.editorFileTree,
    expandedPaths: appState.editorExpandedPaths,
    gitBadgeByPath: appState.editorGitBadgeByPath,
    selectedTreePath: appState.editorSelectedTreePath,
    pendingExplorerEdit: appState.editorPendingExplorerEdit,
    pendingExplorerDelete: appState.editorPendingExplorerDelete,
    branchSubLine: sourceControlBindings.branchLine,
    onRefresh: explorerBindings.refresh,
    onToggleDirectory: explorerBindings.toggleDirectory,
    onOpenFile: explorerBindings.openFile,
    onOpenFileToSide: explorerBindings.openFileToSide,
    onCreateNode: explorerBindings.createNode,
    onDeleteNode: explorerBindings.deleteNode,
    onRenameNode: explorerBindings.renameNode,
    onSelectTreePath: explorerBindings.selectTreePath,
    onBeginCreateFile: explorerBindings.beginCreateFile,
    onBeginCreateFolder: explorerBindings.beginCreateFolder,
    onBeginRename: explorerBindings.beginRename,
    onBeginDelete: explorerBindings.beginDelete,
    onCancelExplorerEdit: explorerBindings.cancelExplorerEdit,
    onCollapseAll: explorerBindings.collapseAll,
    onMoveTreeSelection: explorerBindings.moveTreeSelection,
    onRevealInFinder: explorerBindings.revealInFinder,
    onOpenWithSystemApp: explorerBindings.openWithSystemApp,
    onOpenInTerminal: explorerBindings.openInTerminal,
    onCopyPath: explorerBindings.copyPath,
    canPaste: appState.fileClipboardCanPaste,
    pendingClipboardCollision: appState.fileClipboardPendingCollision,
    onClipboardCut: explorerBindings.cutClipboardItems,
    onClipboardCopy: explorerBindings.copyClipboardItems,
    onClipboardPaste: explorerBindings.pasteClipboardItems,
    onClipboardResolveCollision: explorerBindings.resolveClipboardCollision,
    onClipboardCancelCollision: explorerBindings.cancelClipboardCollision,
    resolveExternalFilePath: explorerBindings.resolveExternalFilePath,
    onExternalFilesDrop: explorerBindings.copyExternalFilesIntoTree,
    onStartFileDrag: explorerBindings.startFileDrag,
    onCompareFiles: explorerBindings.compareFiles,
    sourceControlAvailable: true,
    onStagePath: sourceControlBindings.stagePath,
    onDiscardPath: sourceControlBindings.discardPath,
    onViewDiff: sourceControlBindings.viewDiff,
  };
}
