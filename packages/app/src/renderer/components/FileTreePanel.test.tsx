import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceFileKind } from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorTreeSelectionMovement } from "../stores/editor-store";
import { fileTreeMultiSelectStore } from "../stores/file-tree-multi-select-store";
import {
  FILE_TREE_INDENT,
  FILE_TREE_ROW_HEIGHT,
  FileTreePanel,
  createNativeDropIndicatorFromEvent,
  createFileTreeArboristData,
  externalDragFilesFromDataTransfer,
  handleCreateSubmit,
  handleEditFormKeyDown,
  handleRenameSubmit,
  handleTreeKeyDown,
  type FileTreePanelProps,
} from "./FileTreePanel";
import { FileTreeContextMenu } from "./file-tree-context-menu";
import {
  FILE_TREE_DRAG_MIME,
  dropPositionFromClientY,
  serializeFileTreeDragData,
  validateFileTreeDrop,
  writeFileTreeDragDataTransfer,
} from "./file-tree-dnd/drag-and-drop";
import { workspaceTabId } from "./WorkspaceStrip";

const workspaceId = "ws_alpha" as WorkspaceId;

const baseProps: FileTreePanelProps = {
  activeWorkspace: {
    id: workspaceId,
    displayName: "Alpha",
    absolutePath: "/tmp/alpha",
  },
  workspaceTabId: workspaceTabId(workspaceId),
  fileTree: {
    workspaceId,
    rootPath: "",
    loading: false,
    errorMessage: null,
    readAt: "2026-04-27T00:00:00.000Z",
    nodes: [
      {
        name: "src",
        path: "src",
        kind: "directory" as const,
        gitBadge: "modified" as const,
        children: [
          {
            name: "index.ts",
            path: "src/index.ts",
            kind: "file" as const,
            gitBadge: "modified" as const,
          },
        ],
      },
    ],
  },
  expandedPaths: { src: true as const },
  gitBadgeByPath: {
    src: "modified" as const,
    "src/index.ts": "modified" as const,
  },
  selectedTreePath: null,
  pendingExplorerEdit: null,
  pendingExplorerDelete: null,
  onRefresh() {},
  onToggleDirectory() {},
  onOpenFile() {},
  onCreateNode() {},
  onDeleteNode() {},
  onRenameNode() {},
  onSelectTreePath() {},
  onBeginCreateFile() {},
  onBeginCreateFolder() {},
  onBeginRename() {},
  onBeginDelete() {},
  onCancelExplorerEdit() {},
  onCollapseAll() {},
  onMoveTreeSelection() {},
};

describe("FileTreePanel", () => {
  test("renders toolbar actions without a permanent create path input", () => {
    let newFileCount = 0;
    let newFolderCount = 0;
    let refreshCount = 0;
    let collapseCount = 0;
    const tree = FileTreePanel({
      ...baseProps,
      onBeginCreateFile(parentPath) {
        expect(parentPath).toBeUndefined();
        newFileCount += 1;
      },
      onBeginCreateFolder(parentPath) {
        expect(parentPath).toBeUndefined();
        newFolderCount += 1;
      },
      onRefresh(id) {
        expect(id).toBe(workspaceId);
        refreshCount += 1;
      },
      onCollapseAll(id) {
        expect(id).toBe(workspaceId);
        collapseCount += 1;
      },
    });

    expect(findText(tree, "Files")).toBe(true);
    expect(findText(tree, "Alpha")).toBe(true);
    const panel = findElementByPredicate(tree, (element) => element.props?.["data-component"] === "file-tree-panel");
    expect(panel?.props.role).toBe("tabpanel");
    expect(panel?.props["aria-labelledby"]).toBe(workspaceTabId(workspaceId));
    expect(findText(tree, "New File")).toBe(true);
    expect(findText(tree, "New Folder")).toBe(true);
    expect(findText(tree, "Refresh")).toBe(true);
    expect(findText(tree, "Collapse All")).toBe(true);

    for (const action of [
      "file-tree-new-file",
      "file-tree-new-folder",
      "file-tree-refresh",
      "file-tree-collapse-all",
    ]) {
      const button = findElementByPredicate(tree, (element) => element.props?.["data-action"] === action);
      expect(button).toBeDefined();
      button?.props.onClick();
    }

    expect(newFileCount).toBe(1);
    expect(newFolderCount).toBe(1);
    expect(refreshCount).toBe(1);
    expect(collapseCount).toBe(1);
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "file-tree-create-form")).toBeUndefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["aria-label"] === "New file or folder path")).toBeUndefined();
  });

  test("renders a virtualized ARIA tree with VS Code row metrics, guides, badges, and FileIcon", () => {
    const html = renderToStaticMarkup(
      <FileTreePanel
        {...baseProps}
        selectedTreePath="src/index.ts"
      />,
    );

    expect(html).toContain('role="tree"');
    expect(readFileSync(new URL("./FileTreePanel.tsx", import.meta.url), "utf8")).toContain('treeElement.setAttribute("aria-multiselectable", "true")');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain(`height:${FILE_TREE_ROW_HEIGHT}px`);
    expect(html).toContain(`padding-left:${FILE_TREE_INDENT}px`);
    expect(html).toContain('data-file-tree-indent-guide="true"');
    expect(html).toContain('class="absolute top-0 block h-full w-px bg-sidebar-border/70"');
    expect(html).toContain('style="left:4px"');
    expect(html).toContain("hover:bg-accent/40");
    expect(html).toContain('data-file-tree-path="src"');
    expect(html).toContain('data-file-tree-path="src/index.ts"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-git-badge-status="modified"');
    expect(html).toContain('aria-label="src git status: modified"');
    expect(html).toContain('data-file-icon-kind="folder"');
    expect(html).toContain('data-file-icon-source="folder_type_src_opened.svg"');
    expect(html).toContain('data-file-icon-kind="file"');
    expect(html).toContain('data-file-icon-source="file_type_typescript.svg"');
    expect(html).toContain('style="width:14px;height:14px"');
  });

  test("wires empty-area and row right-click menus to file actions and clipboard handlers", () => {
    const emptyTree = FileTreePanel({
      ...baseProps,
      fileTree: {
        ...baseProps.fileTree,
        nodes: [],
      },
      canPaste: true,
    });
    const emptyMenu = findElementByPredicate(
      emptyTree,
      (element) => element.type === FileTreeContextMenu,
    );

    expect(emptyMenu?.props.kind).toBe("empty");
    expect(emptyMenu?.props.canPaste).toBe(true);
    expect(emptyMenu?.props.onBeginCreateFile).toBe(baseProps.onBeginCreateFile);
    expect(emptyMenu?.props.onBeginCreateFolder).toBe(baseProps.onBeginCreateFolder);
    expect(emptyMenu?.props.onRefresh).toBe(baseProps.onRefresh);

    const source = readFileSync(new URL("./FileTreePanel.tsx", import.meta.url), "utf8");
    expect(source).toContain('kind={isDirectory ? "folder" : "file"}');
    expect(source).toContain("onOpenWithSystemApp={panelProps.onOpenWithSystemApp}");
    expect(source).toContain("onRevealInFinder={panelProps.onRevealInFinder}");
    expect(source).toContain("onOpenInTerminal={panelProps.onOpenInTerminal}");
    expect(source).toContain("onCut={panelProps.onClipboardCut}");
    expect(source).toContain("onCopy={panelProps.onClipboardCopy}");
    expect(source).toContain("selectedItems={selectedItemsForContextMenu");
    expect(source).toContain("onCompare={(target, anchor) =>");
    expect(source).toContain("onPaste={panelProps.onClipboardPaste}");
    expect(source).toContain("onStage={panelProps.onStagePath}");
    expect(source).toContain("onDiscard={panelProps.onDiscardPath}");
    expect(source).toContain("onViewDiff={panelProps.onViewDiff}");
    expect(source).toContain("onContextMenu={(event) =>");
    expect(source).toContain("event.stopPropagation();");
  });

  test("keeps deterministic guards for selected focus/unfocus styling and active-row scrolling", () => {
    const source = readFileSync(new URL("./FileTreePanel.tsx", import.meta.url), "utf8");

    expect(source).toContain('isSelected && arboristNode.isFocused && "bg-accent text-accent-foreground"');
    expect(source).toContain('isSelected && !arboristNode.isFocused && "bg-muted/40 text-sidebar-foreground"');
    expect(source).toContain('void tree?.scrollTo(selectedTreePath, "smart")');
    expect(source).toContain("!tree.isFocused(selectedTreePath)");
    expect(source).toContain('tree.focus(selectedTreePath, { scroll: false })');
    expect(source).toContain('data-action="file-tree-confirm-delete"');
    expect(source).toContain("onDeleteNode(workspaceId, node.path, node.kind)");
    expect(source).toContain("fileTreeMultiSelectStore");
    expect(source).toContain("renderCursor={FileTreeDropCursor}");
    expect(source).toContain("handleArboristMove");
  });

  test("builds arborist data for inline create rows and explicit delete confirmations", () => {
    const createData = createFileTreeArboristData({
      nodes: baseProps.fileTree.nodes,
      workspaceId,
      expandedPaths: baseProps.expandedPaths,
      pendingExplorerEdit: {
        type: "create",
        workspaceId,
        parentPath: "src",
        kind: "file",
      },
      pendingExplorerDelete: null,
    });
    const srcEntry = createData.find((entry) => entry.entryType === "node" && entry.path === "src");
    expect(srcEntry?.children?.[0]).toMatchObject({
      entryType: "create",
      kind: "file",
      parentPath: "src",
    });

    const collapsedDeleteData = createFileTreeArboristData({
      nodes: baseProps.fileTree.nodes,
      workspaceId,
      expandedPaths: {},
      pendingExplorerEdit: null,
      pendingExplorerDelete: {
        workspaceId,
        path: "src",
        kind: "directory",
      },
    });
    expect(collapsedDeleteData[0]).toMatchObject({ entryType: "node", path: "src" });
    expect(collapsedDeleteData[1]).toMatchObject({ entryType: "delete", path: "src" });

    const expandedDeleteData = createFileTreeArboristData({
      nodes: baseProps.fileTree.nodes,
      workspaceId,
      expandedPaths: { src: true as const },
      pendingExplorerEdit: null,
      pendingExplorerDelete: {
        workspaceId,
        path: "src",
        kind: "directory",
      },
    });
    const expandedSrcEntry = expandedDeleteData.find((entry) => entry.entryType === "node" && entry.path === "src");
    expect(expandedSrcEntry?.children?.[0]).toMatchObject({ entryType: "delete", path: "src" });
  });

  test("commits and cancels inline create and rename handlers with basename-only inputs", () => {
    const createCalls: Array<[WorkspaceId, string, WorkspaceFileKind]> = [];
    handleCreateSubmit(
      fakeBasenameSubmitEvent(" new.ts ") as never,
      workspaceId,
      {
        type: "create",
        workspaceId,
        parentPath: "src",
        kind: "file",
      },
      (workspaceId, path, kind) => {
        createCalls.push([workspaceId, path, kind]);
      },
    );
    handleCreateSubmit(
      fakeBasenameSubmitEvent(" invalid/name.ts ") as never,
      workspaceId,
      {
        type: "create",
        workspaceId,
        parentPath: "src",
        kind: "file",
      },
      (workspaceId, path, kind) => {
        createCalls.push([workspaceId, path, kind]);
      },
    );
    expect(createCalls).toEqual([[workspaceId, "src/new.ts", "file"]]);

    const renameCalls: Array<[WorkspaceId, string, string]> = [];
    let cancelCount = 0;
    handleRenameSubmit(
      fakeBasenameSubmitEvent(" main.ts ") as never,
      workspaceId,
      "src/index.ts",
      "src",
      (workspaceId, oldPath, newPath) => {
        renameCalls.push([workspaceId, oldPath, newPath]);
      },
      () => {
        cancelCount += 1;
      },
    );
    handleRenameSubmit(
      fakeBasenameSubmitEvent(" index.ts ") as never,
      workspaceId,
      "src/index.ts",
      "src",
      (workspaceId, oldPath, newPath) => {
        renameCalls.push([workspaceId, oldPath, newPath]);
      },
      () => {
        cancelCount += 1;
      },
    );

    expect(renameCalls).toEqual([[workspaceId, "src/index.ts", "src/main.ts"]]);
    expect(cancelCount).toBe(1);

    handleEditFormKeyDown(fakeKeyboardEvent("Escape") as never, () => {
      cancelCount += 1;
    });
    handleEditFormKeyDown(fakeKeyboardEvent("Escape", null, { isComposing: true }) as never, () => {
      cancelCount += 1;
    });
    handleEditFormKeyDown(fakeKeyboardEvent("Escape", null, { keyCode: 229 }) as never, () => {
      cancelCount += 1;
    });
    expect(cancelCount).toBe(2);
  });

  test("handles keyboard navigation, file activation, edit actions, selected path, and IME guards", () => {
    const moves: EditorTreeSelectionMovement[] = [];
    const openCalls: Array<[WorkspaceId, string]> = [];
    const renameCalls: Array<[string, WorkspaceFileKind]> = [];
    const deleteCalls: Array<[string, WorkspaceFileKind]> = [];
    let cancelCount = 0;
    const props: FileTreePanelProps = {
      ...baseProps,
      selectedTreePath: "src/index.ts",
      onMoveTreeSelection(movement) {
        moves.push(movement);
      },
      onOpenFile(workspaceId, path) {
        openCalls.push([workspaceId, path]);
      },
      onBeginRename(path, kind) {
        renameCalls.push([path, kind]);
      },
      onBeginDelete(path, kind) {
        deleteCalls.push([path, kind]);
      },
      onCancelExplorerEdit() {
        cancelCount += 1;
      },
    };

    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "ArrowLeft", "ArrowRight"]) {
      handleTreeKeyDown(fakeKeyboardEvent(key) as never, workspaceId, props);
    }
    handleTreeKeyDown(fakeKeyboardEvent("Enter") as never, workspaceId, props);
    handleTreeKeyDown(fakeKeyboardEvent(" ") as never, workspaceId, props);
    handleTreeKeyDown(fakeKeyboardEvent("F2") as never, workspaceId, props);
    handleTreeKeyDown(fakeKeyboardEvent("Delete") as never, workspaceId, props);
    handleTreeKeyDown(fakeKeyboardEvent("Backspace") as never, workspaceId, props);
    handleTreeKeyDown(fakeKeyboardEvent("Escape") as never, workspaceId, props);

    const composingEnter = fakeKeyboardEvent("Enter", null, { nativeEvent: { isComposing: true } });
    const composingKeyCode = fakeKeyboardEvent("Delete", null, { keyCode: 229 });
    const inputDelete = fakeKeyboardEvent("Delete", { tagName: "INPUT" });

    handleTreeKeyDown(composingEnter as never, workspaceId, props);
    handleTreeKeyDown(composingKeyCode as never, workspaceId, props);
    handleTreeKeyDown(inputDelete as never, workspaceId, props);

    expect(moves).toEqual(["previous", "next", "first", "last", "parent", "child"]);
    expect(openCalls).toEqual([
      [workspaceId, "src/index.ts"],
      [workspaceId, "src/index.ts"],
    ]);
    expect(renameCalls).toEqual([["src/index.ts", "file"]]);
    expect(deleteCalls).toEqual([
      ["src/index.ts", "file"],
      ["src/index.ts", "file"],
    ]);
    expect(cancelCount).toBe(1);
    expect(composingEnter.stopped).toBe(true);
    expect(composingKeyCode.stopped).toBe(true);
    expect(inputDelete.prevented).toBe(false);
  });

  test("handles Cmd+A, Shift+Arrow range selection, and Escape clear through the multi-select store", () => {
    fileTreeMultiSelectStore.setState({
      selectedPaths: new Set<string>(),
      lastAnchor: null,
      compareAnchor: null,
    });
    const selectedPaths: string[] = [];
    const props: FileTreePanelProps = {
      ...baseProps,
      selectedTreePath: "src",
      onSelectTreePath(path) {
        if (path) {
          selectedPaths.push(path);
        }
      },
    };

    handleTreeKeyDown(fakeKeyboardEvent("a", null, { metaKey: true }) as never, workspaceId, props);
    expect(Array.from(fileTreeMultiSelectStore.getState().selectedPaths)).toEqual(["src/index.ts"]);

    fileTreeMultiSelectStore.getState().clearSelect();
    fileTreeMultiSelectStore.getState().toggleSelect("src");
    handleTreeKeyDown(
      fakeKeyboardEvent("ArrowDown", null, { shiftKey: true }) as never,
      workspaceId,
      props,
      ["src", "src/index.ts"],
    );
    expect(Array.from(fileTreeMultiSelectStore.getState().selectedPaths)).toEqual(["src", "src/index.ts"]);
    expect(selectedPaths).toEqual(["src/index.ts"]);

    handleTreeKeyDown(fakeKeyboardEvent("Escape") as never, workspaceId, props);
    expect(fileTreeMultiSelectStore.getState().selectedPaths.size).toBe(0);
  });

  test("keeps 10k-file rendering virtualized", () => {
    const nodes = Array.from({ length: 10_000 }, (_, index) => ({
      name: `file-${index}.ts`,
      path: `file-${index}.ts`,
      kind: "file" as const,
    }));
    const html = renderToStaticMarkup(
      <FileTreePanel
        {...baseProps}
        fileTree={{
          ...baseProps.fileTree,
          nodes,
        }}
        expandedPaths={{}}
        gitBadgeByPath={{}}
      />,
    );

    expect(html).toContain("file-0.ts");
    expect(html).not.toContain("file-9999.ts");
    expect(countOccurrences(html, 'role="treeitem"')).toBeLessThan(100);
    expect(html).toContain(`height:${10_000 * FILE_TREE_ROW_HEIGHT}px`);
  });

  test("classifies drop y-position into insert, over, and insert branches", () => {
    expect(dropPositionFromClientY({ clientY: 102, rowTop: 100, rowHeight: 22 })).toBe("insert-above");
    expect(dropPositionFromClientY({ clientY: 111, rowTop: 100, rowHeight: 22 })).toBe("over");
    expect(dropPositionFromClientY({ clientY: 119, rowTop: 100, rowHeight: 22 })).toBe("insert-below");
  });

  test("blocks invalid tree drops for self, child folder, git ignored, different workspace, and multi-drag", () => {
    expect(validateFileTreeDrop({
      sourceWorkspaceId: workspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [{ path: "src", kind: "directory" }],
      targetParentPath: "src",
    })).toEqual({ valid: false, reason: "self" });

    expect(validateFileTreeDrop({
      sourceWorkspaceId: workspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [{ path: "src", kind: "directory" }],
      targetParentPath: "src/child",
    })).toEqual({ valid: false, reason: "child" });

    expect(validateFileTreeDrop({
      sourceWorkspaceId: workspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [{ path: "ignored.log", kind: "file", gitStatus: "ignored" }],
      targetParentPath: null,
    })).toEqual({ valid: false, reason: "git-ignored" });

    expect(validateFileTreeDrop({
      sourceWorkspaceId: "ws_beta" as WorkspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [{ path: "src/index.ts", kind: "file" }],
      targetParentPath: null,
    })).toEqual({ valid: false, reason: "different-workspace" });

    expect(validateFileTreeDrop({
      sourceWorkspaceId: workspaceId,
      targetWorkspaceId: workspaceId,
      draggedNodes: [
        { path: "a.ts", kind: "file" },
        { path: "b.ts", kind: "file" },
      ],
      targetParentPath: null,
    })).toEqual({ valid: false, reason: "multi-drag" });
  });

  test("builds native drop indicators and external drag-in file descriptors", () => {
    const dataTransfer = fakeDataTransfer();
    writeFileTreeDragDataTransfer(dataTransfer as never, {
      workspaceId,
      path: "src/index.ts",
      kind: "file",
    });
    expect(dataTransfer.getData(FILE_TREE_DRAG_MIME)).toBe(serializeFileTreeDragData({
      workspaceId,
      path: "src/index.ts",
      kind: "file",
    }));

    const indicator = createNativeDropIndicatorFromEvent({
      event: fakeDragEvent({
        dataTransfer,
        target: fakeRowElement({
          path: "src",
          parentPath: "",
          top: 100,
          height: 22,
        }),
        clientY: 111,
      }) as never,
      workspaceId,
      gitBadgeByPath: {},
      fileTreeNodes: baseProps.fileTree.nodes,
    });

    expect(indicator).toMatchObject({
      targetPath: "src",
      targetDirectory: "src",
      state: "over",
      position: "over",
    });

    const externalFiles = externalDragFilesFromDataTransfer(
      {
        files: [
          { name: "big.bin", size: 101 * 1024 * 1024 },
        ],
      } as never,
      () => "/Users/kih/Desktop/big.bin",
    );
    expect(externalFiles).toEqual([
      {
        absolutePath: "/Users/kih/Desktop/big.bin",
        name: "big.bin",
        size: 101 * 1024 * 1024,
      },
    ]);
  });
});

function fakeBasenameSubmitEvent(basename: string) {
  return {
    preventDefault() {},
    currentTarget: {
      elements: {
        namedItem(name: string) {
          return name === "basename" ? { value: basename } : null;
        },
      },
    },
  };
}

function fakeKeyboardEvent(
  key: string,
  target: ({ tagName?: string; isContentEditable?: boolean } & EventTarget) | null = null,
  options: {
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
  } = {},
) {
  return {
    key,
    target,
    metaKey: options.metaKey,
    ctrlKey: options.ctrlKey,
    shiftKey: options.shiftKey,
    isComposing: options.isComposing,
    keyCode: options.keyCode,
    nativeEvent: options.nativeEvent,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}

function fakeDataTransfer() {
  const values = new Map<string, string>();
  const types: string[] = [];
  return {
    types,
    files: [],
    effectAllowed: "all",
    dropEffect: "move",
    setData(type: string, value: string) {
      if (!types.includes(type)) {
        types.push(type);
      }
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
  };
}

function fakeDragEvent({
  dataTransfer,
  target,
  clientY,
}: {
  dataTransfer: ReturnType<typeof fakeDataTransfer>;
  target: unknown;
  clientY: number;
}) {
  return {
    dataTransfer,
    target,
    clientY,
  };
}

function fakeRowElement({
  path,
  parentPath,
  top,
  height,
}: {
  path: string;
  parentPath: string;
  top: number;
  height: number;
}) {
  return {
    closest(selector: string) {
      if (selector !== '[data-file-tree-row="true"]') {
        return null;
      }
      return {
        dataset: {
          fileTreePath: path,
          parentPath,
        },
        getBoundingClientRect() {
          return {
            top,
            height,
          };
        },
      };
    },
  };
}

function findElementByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  if (isReactElement(node)) {
    if (predicate(node)) {
      return node;
    }

    if (shouldExpandFunctionElement(node)) {
      return findElementByPredicate(node.type(node.props), predicate);
    }

    return findElementByPredicate(node.props.children, predicate);
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElementByPredicate(child, predicate);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

function findText(node: ReactNode, text: string): boolean {
  return textContent(node).includes(text);
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (isReactElement(node)) {
    if (shouldExpandFunctionElement(node)) {
      return textContent(node.type(node.props));
    }

    const propText = [node.props.title, node.props.description]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .join(" ");
    return `${propText} ${textContent(node.props.children)}`;
  }

  if (Array.isArray(node)) {
    return node.map((child) => textContent(child)).join("");
  }

  return "";
}

function shouldExpandFunctionElement(element: ReactElement): element is ReactElement & {
  type: (props: Record<string, unknown>) => ReactNode;
} {
  if (typeof element.type !== "function") {
    return false;
  }

  return !["FileTreeArboristViewport", "FileIcon"].includes(element.type.name);
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
