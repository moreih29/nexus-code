import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceFileKind } from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorTreeSelectionMovement } from "../stores/editor-store";
import { FileTreePanel, type FileTreePanelProps } from "./FileTreePanel";

const workspaceId = "ws_alpha" as WorkspaceId;

const baseProps: FileTreePanelProps = {
  activeWorkspace: {
    id: workspaceId,
    displayName: "Alpha",
    absolutePath: "/tmp/alpha",
  },
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

  test("renders tree semantics, active row attributes, expanded children, and git badge aria labels", () => {
    const tree = FileTreePanel({
      ...baseProps,
      selectedTreePath: "src/index.ts",
    });

    expect(findText(tree, "src")).toBe(true);
    expect(findText(tree, "index.ts")).toBe(true);

    const treeRoot = findElementByPredicate(tree, (element) => element.props?.role === "tree");
    expect(treeRoot?.props["aria-activedescendant"]).toBe("file-tree-ws_alpha-src_index_ts");
    expect(treeRoot?.props["data-active-path"]).toBe("src/index.ts");

    const directoryRow = findElementByPath(tree, "src");
    expect(directoryRow?.props.role).toBe("treeitem");
    expect(directoryRow?.props["aria-expanded"]).toBe(true);

    const selectedRow = findElementByPath(tree, "src/index.ts");
    expect(selectedRow?.props.role).toBe("treeitem");
    expect(selectedRow?.props["aria-selected"]).toBe(true);
    expect(selectedRow?.props["data-selected"]).toBe("true");
    expect(selectedRow?.props["data-active"]).toBe("true");

    const badge = findElementByPredicate(
      tree,
      (element) => element.props?.["data-git-badge-status"] === "modified",
    );
    expect(badge?.props["aria-label"]).toBe("src git status: modified");
  });

  test("commits and cancels inline create rows at the requested target", () => {
    const createCalls: Array<[WorkspaceId, string, WorkspaceFileKind]> = [];
    let cancelCount = 0;
    const tree = FileTreePanel({
      ...baseProps,
      pendingExplorerEdit: {
        type: "create",
        workspaceId,
        parentPath: "src",
        kind: "file",
      },
      onCreateNode(workspaceId, path, kind) {
        createCalls.push([workspaceId, path, kind]);
      },
      onCancelExplorerEdit() {
        cancelCount += 1;
      },
    });

    const createRow = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "file-tree-create-row",
    );
    expect(createRow?.props["data-parent-path"]).toBe("src");

    const createForm = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "file-tree-create-form",
    );
    expect(createForm).toBeDefined();
    expect(findElementByPredicate(createForm, (element) => element.props?.["aria-label"] === "New file name")).toBeDefined();

    createForm?.props.onSubmit(fakeBasenameSubmitEvent(" new.ts "));

    const cancel = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "file-tree-cancel-edit",
    );
    cancel?.props.onClick();

    expect(createCalls).toEqual([[workspaceId, "src/new.ts", "file"]]);
    expect(cancelCount).toBe(1);
  });

  test("commits and cancels inline rename with a basename input", () => {
    const renameCalls: Array<[WorkspaceId, string, string]> = [];
    let cancelCount = 0;
    const tree = FileTreePanel({
      ...baseProps,
      pendingExplorerEdit: {
        type: "rename",
        workspaceId,
        path: "src/index.ts",
        kind: "file",
      },
      onRenameNode(workspaceId, oldPath, newPath) {
        renameCalls.push([workspaceId, oldPath, newPath]);
      },
      onCancelExplorerEdit() {
        cancelCount += 1;
      },
    });

    const renameForm = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "file-tree-rename-form",
    );
    expect(renameForm).toBeDefined();

    const renameInput = findElementByPredicate(
      renameForm,
      (element) => element.props?.["aria-label"] === "Rename index.ts basename",
    );
    expect(renameInput?.props.defaultValue).toBe("index.ts");

    renameForm?.props.onSubmit(fakeBasenameSubmitEvent(" main.ts "));
    renameForm?.props.onKeyDown(fakeKeyboardEvent("Escape"));

    expect(renameCalls).toEqual([[workspaceId, "src/index.ts", "src/main.ts"]]);
    expect(cancelCount).toBe(1);
  });

  test("requires explicit confirmation before deleting a row", () => {
    const beginDeleteCalls: Array<[string, WorkspaceFileKind]> = [];
    const deleteCalls: Array<[WorkspaceId, string, WorkspaceFileKind]> = [];
    const tree = FileTreePanel({
      ...baseProps,
      onBeginDelete(path, kind) {
        beginDeleteCalls.push([path, kind]);
      },
      onDeleteNode(workspaceId, path, kind) {
        deleteCalls.push([workspaceId, path, kind]);
      },
    });

    const deleteButton = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "file-tree-delete" && element.props?.["data-path"] === "src",
    );
    deleteButton?.props.onClick();

    expect(beginDeleteCalls).toEqual([["src", "directory"]]);
    expect(deleteCalls).toEqual([]);
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "file-tree-confirm-delete")).toBeUndefined();

    const confirmTree = FileTreePanel({
      ...baseProps,
      pendingExplorerDelete: {
        workspaceId,
        path: "src",
        kind: "directory",
      },
      onDeleteNode(workspaceId, path, kind) {
        deleteCalls.push([workspaceId, path, kind]);
      },
    });
    const confirm = findElementByPredicate(
      confirmTree,
      (element) => element.props?.["data-action"] === "file-tree-confirm-delete",
    );
    confirm?.props.onClick();

    expect(deleteCalls).toEqual([[workspaceId, "src", "directory"]]);
  });

  test("handles representative tree keyboard navigation and row actions", () => {
    const moves: EditorTreeSelectionMovement[] = [];
    const openCalls: Array<[WorkspaceId, string]> = [];
    const renameCalls: Array<[string, WorkspaceFileKind]> = [];
    const deleteCalls: Array<[string, WorkspaceFileKind]> = [];
    let cancelCount = 0;
    const tree = FileTreePanel({
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
    });
    const treeRoot = findElementByPredicate(tree, (element) => element.props?.role === "tree");

    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "ArrowLeft", "ArrowRight"]) {
      treeRoot?.props.onKeyDown(fakeKeyboardEvent(key));
    }
    treeRoot?.props.onKeyDown(fakeKeyboardEvent("Enter"));
    treeRoot?.props.onKeyDown(fakeKeyboardEvent(" "));
    treeRoot?.props.onKeyDown(fakeKeyboardEvent("F2"));
    treeRoot?.props.onKeyDown(fakeKeyboardEvent("Delete"));
    treeRoot?.props.onKeyDown(fakeKeyboardEvent("Backspace"));
    treeRoot?.props.onKeyDown(fakeKeyboardEvent("Escape"));

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

function fakeKeyboardEvent(key: string, target: EventTarget | null = null) {
  return {
    key,
    target,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function findElementByPath(node: ReactNode, path: string): ReactElement | undefined {
  return findElementByPredicate(node, (element) => element.props?.["data-file-tree-path"] === path);
}

function findElementByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  if (isReactElement(node)) {
    if (predicate(node)) {
      return node;
    }

    if (typeof node.type === "function") {
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
    if (typeof node.type === "function") {
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
