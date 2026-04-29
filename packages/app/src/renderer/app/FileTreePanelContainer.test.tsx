import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { FileTreePanel, type FileTreePanelProps } from "../components/FileTreePanel";
import type { ExplorerBindings } from "./useExplorerBindings";
import type { SourceControlBindings } from "./useSourceControlBindings";
import {
  FileTreePanelContainer,
  createFileTreePanelProps,
  type FileTreePanelContainerState,
} from "./FileTreePanelContainer";

const workspaceId = "ws_alpha" as WorkspaceId;
const activeWorkspace = {
  id: workspaceId,
  displayName: "Alpha",
  absolutePath: "/tmp/alpha",
};

describe("FileTreePanelContainer", () => {
  test("maps AppShell state and bindings to FileTreePanel props", () => {
    const explorerBindings = createExplorerBindings();
    const sourceControlBindings = createSourceControlBindings({ branchLine: "main ↑1 ↓0" });
    const appState = createContainerState();

    const element = FileTreePanelContainer({
      appState,
      bindings: { explorerBindings, sourceControlBindings },
    }) as ReactElement<FileTreePanelProps>;

    expect(element.type).toBe(FileTreePanel);
    expect(element.props.activeWorkspace).toBe(activeWorkspace);
    expect(element.props.workspaceTabId).toBe("workspace-tab-ws_alpha");
    expect(element.props.fileTree).toBe(appState.editorFileTree);
    expect(element.props.expandedPaths).toBe(appState.editorExpandedPaths);
    expect(element.props.gitBadgeByPath).toBe(appState.editorGitBadgeByPath);
    expect(element.props.selectedTreePath).toBe("src/index.ts");
    expect(element.props.branchSubLine).toBe("main ↑1 ↓0");
    expect(element.props.onRefresh).toBe(explorerBindings.refresh);
    expect(element.props.onOpenFileToSide).toBe(explorerBindings.openFileToSide);
    expect(element.props.onClipboardPaste).toBe(explorerBindings.pasteClipboardItems);
    expect(element.props.sourceControlAvailable).toBe(true);
    expect(element.props.onStagePath).toBe(sourceControlBindings.stagePath);
    expect(element.props.onDiscardPath).toBe(sourceControlBindings.discardPath);
    expect(element.props.onViewDiff).toBe(sourceControlBindings.viewDiff);
  });

  test("keeps no-workspace and clipboard collision mapping without creating binding hooks", () => {
    let resolvedStrategy: string | null = null;
    const explorerBindings = createExplorerBindings({
      resolveClipboardCollision(strategy) {
        resolvedStrategy = strategy;
      },
    });
    const sourceControlBindings = createSourceControlBindings({ branchLine: null });
    const collision = {
      request: {
        type: "file-actions/clipboard/paste" as const,
        workspaceId,
        targetDirectory: null,
        operation: "copy" as const,
        entries: [{ workspaceId, path: "src/index.ts", kind: "file" as const }],
        conflictStrategy: "prompt" as const,
      },
      collisions: [],
    };
    const appState = createContainerState({
      activeWorkspace: null,
      activeWorkspaceTabId: undefined,
      fileClipboardCanPaste: true,
      fileClipboardPendingCollision: collision,
    });

    const props = createFileTreePanelProps({
      appState,
      bindings: { explorerBindings, sourceControlBindings },
    });

    expect(props.activeWorkspace).toBeNull();
    expect(props.workspaceTabId).toBeUndefined();
    expect(props.canPaste).toBe(true);
    expect(props.pendingClipboardCollision).toBe(collision);

    props.onClipboardResolveCollision?.("keep-both");
    expect(resolvedStrategy).toBe("keep-both");
  });
});

function createContainerState(
  overrides: Partial<FileTreePanelContainerState> = {},
): FileTreePanelContainerState {
  return {
    activeWorkspace,
    activeWorkspaceTabId: "workspace-tab-ws_alpha",
    editorFileTree: {
      workspaceId,
      rootPath: "/tmp/alpha",
      nodes: [{ name: "src", path: "src", kind: "directory", children: [] }],
      loading: false,
      errorMessage: null,
      readAt: "2026-04-30T00:00:00.000Z",
    },
    editorExpandedPaths: { src: true },
    editorGitBadgeByPath: { "src/index.ts": "modified" },
    editorSelectedTreePath: "src/index.ts",
    editorPendingExplorerEdit: null,
    editorPendingExplorerDelete: null,
    fileClipboardCanPaste: false,
    fileClipboardPendingCollision: null,
    ...overrides,
  };
}

function createExplorerBindings(overrides: Partial<ExplorerBindings> = {}): ExplorerBindings {
  return {
    beginCreateFile() {},
    beginCreateFolder() {},
    beginDelete() {},
    beginRename() {},
    cancelClipboardCollision() {},
    cancelExplorerEdit() {},
    collapseAll() {},
    compareFiles() {},
    copyClipboardItems() {},
    async copyExternalFilesIntoTree(request) {
      return {
        type: "file-actions/external-drag-in/result",
        workspaceId: request.workspaceId,
        applied: [],
        collisions: [],
        skipped: [],
        largeFiles: [],
      };
    },
    copyPath() {},
    createNode() {},
    cutClipboardItems() {},
    deleteNode() {},
    moveTreeSelection() {},
    openFile() {},
    openFileToSide() {},
    openInTerminal() {},
    openWithSystemApp() {},
    pasteClipboardItems() {},
    refresh() {},
    renameNode() {},
    resolveClipboardCollision() {},
    resolveExternalFilePath() {
      return "/tmp/file.txt";
    },
    revealInFinder() {},
    selectTreePath() {},
    startFileDrag() {},
    toggleDirectory() {},
    ...overrides,
  };
}

function createSourceControlBindings(overrides: Partial<SourceControlBindings> = {}): SourceControlBindings {
  return {
    branchLine: null,
    discardPath() {},
    openDiffTab() {},
    stagePath() {},
    viewDiff() {},
    ...overrides,
  };
}
