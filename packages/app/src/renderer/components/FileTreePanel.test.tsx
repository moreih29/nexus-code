import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import { FileTreePanel } from "./FileTreePanel";

const workspaceId = "ws_alpha" as WorkspaceId;

const baseProps = {
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
  onRefresh() {},
  onToggleDirectory() {},
  onOpenFile() {},
  onCreateNode() {},
  onDeleteNode() {},
  onRenameNode() {},
};

describe("FileTreePanel", () => {
  test("renders active workspace file tree with expanded children and git badge aria labels", () => {
    const tree = FileTreePanel(baseProps);

    expect(findText(tree, "Files")).toBe(true);
    expect(findText(tree, "Alpha")).toBe(true);
    expect(findText(tree, "src")).toBe(true);
    expect(findText(tree, "index.ts")).toBe(true);

    const toggle = findElementByPredicate(
      tree,
      (element) => element.props?.["data-action"] === "file-tree-toggle" && element.props?.["data-path"] === "src",
    );
    expect(toggle?.props["aria-expanded"]).toBe(true);

    const badge = findElementByPredicate(
      tree,
      (element) => element.props?.["data-git-badge-status"] === "modified",
    );
    expect(badge?.props["aria-label"]).toBe("src git status: modified");
  });

  test("exposes create, rename, delete, refresh, and open-file actions", () => {
    const tree = FileTreePanel(baseProps);

    for (const action of [
      "file-tree-new-file",
      "file-tree-new-folder",
      "file-tree-refresh",
      "file-tree-open-file",
      "file-tree-rename",
      "file-tree-delete",
    ]) {
      expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === action)).toBeDefined();
    }
  });
});

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
