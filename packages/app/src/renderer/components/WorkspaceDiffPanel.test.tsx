import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceDiffResult } from "../../../../shared/src/contracts/e3-surfaces";
import { WorkspaceDiffPanelView } from "./WorkspaceDiffPanel";

const loadedResult: WorkspaceDiffResult = {
  available: true,
  workspacePath: "/repo",
  generatedAt: "2026-04-26T05:16:00.000Z",
  selectedFilePath: "hello.py",
  files: [
    { path: "hello.py", status: " M", kind: "modified" },
    { path: "notes/new.txt", status: "??", kind: "untracked" },
  ],
  diff: "diff --git a/hello.py b/hello.py\n+print('你好')",
};

describe("WorkspaceDiffPanelView", () => {
  test("renders an empty state without an active workspace", () => {
    const tree = WorkspaceDiffPanelView({
      workspacePath: null,
      result: null,
      selectedFilePath: null,
      loading: false,
    });

    expect(findText(tree, "No workspace selected")).toBe(true);
    expect(findText(tree, "Open a workspace to review git changes produced around Claude Code turns.")).toBe(true);
  });

  test("renders changed files and selected textual diff", () => {
    const tree = WorkspaceDiffPanelView({
      workspacePath: "/repo",
      activeWorkspaceName: "Alpha",
      result: loadedResult,
      selectedFilePath: "hello.py",
      loading: false,
    });

    expect(findText(tree, "Workspace diff")).toBe(true);
    expect(findText(tree, "2 files")).toBe(true);
    expect(findText(tree, "hello.py")).toBe(true);
    expect(findText(tree, "notes/new.txt")).toBe(true);
    expect(findText(tree, "+print('你好')")).toBe(true);

    const activeFiles = findElementsByProp(tree, "data-diff-file-active").map(
      (element) => element.props["data-diff-file-active"],
    );
    expect(activeFiles).toEqual(["true", "false"]);
  });

  test("renders unavailable diff state", () => {
    const tree = WorkspaceDiffPanelView({
      workspacePath: "/repo",
      result: {
        available: false,
        workspacePath: "/repo",
        reason: "Git repository is unavailable.",
        generatedAt: "2026-04-26T05:16:00.000Z",
      },
      selectedFilePath: null,
      loading: false,
    });

    expect(findText(tree, "Diff unavailable")).toBe(true);
    expect(findText(tree, "Git repository is unavailable.")).toBe(true);
  });
});

function findElementsByProp(
  node: ReactNode,
  propName: string,
): ReactElement[] {
  const results: ReactElement[] = [];
  visitElements(node, (element) => {
    if (element.props?.[propName] !== undefined) {
      results.push(element);
    }
  });
  return results;
}

function visitElements(node: ReactNode, visit: (element: ReactElement) => void): void {
  if (isReactElement(node)) {
    visit(node);
    visitElements(node.props.children, visit);
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      visitElements(child, visit);
    }
  }
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
