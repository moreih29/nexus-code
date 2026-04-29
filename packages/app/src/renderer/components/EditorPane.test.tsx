import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorTab } from "../services/editor-types";
import { DiffEditorHost } from "./DiffEditorHost";
import { EditorPaneView } from "./EditorPane";
import { MonacoEditorHost } from "./MonacoEditorHost";

const workspaceId = "ws_alpha" as WorkspaceId;
const tab: EditorTab = {
  kind: "file",
  id: "ws_alpha::src/index.ts",
  workspaceId,
  path: "src/index.ts",
  title: "index.ts",
  content: "const value = missing;\n",
  savedContent: "const value = missing;\n",
  version: "v1",
  dirty: true,
  saving: false,
  errorMessage: null,
  language: "typescript",
  monacoLanguage: "typescript",
  lspDocumentVersion: 1,
  diagnostics: [
    {
      path: "src/index.ts",
      language: "typescript",
      range: {
        start: { line: 0, character: 14 },
        end: { line: 0, character: 21 },
      },
      severity: "error",
      message: "Cannot find name 'missing'.",
    },
  ],
  lspStatus: {
    language: "typescript",
    state: "ready",
    serverName: "typescript-language-server",
    message: "typescript-language-server is ready.",
    updatedAt: "2026-04-27T00:00:00.000Z",
  },
};

describe("EditorPaneView", () => {
  test("renders content-only active Monaco editor host without an internal tab bar or toolbar", () => {
    const inactiveTab: EditorTab = {
      ...tab,
      id: "ws_alpha::README.md",
      path: "README.md",
      title: "README.md",
      content: "# Alpha\n",
      dirty: false,
      diagnostics: [],
    };
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      active: true,
      tabs: [tab, inactiveTab],
      activeTabId: tab.id,
      onChangeContent() {},
    });

    const pane = findElementByPredicate(tree, (element) => element.props?.["data-component"] === "editor-pane");
    const host = findElementByPredicate(tree, (element) => element.type === MonacoEditorHost);

    expect(pane).toBeDefined();
    expect(String(pane?.props.className)).toContain("focus-visible:outline-1");
    expect(host?.props.path).toBe("src/index.ts");
    expect(host?.props.value).toBe("const value = missing;\n");
    expect(findElementByPredicate(tree, (element) => element.props?.["data-editor-pane-header"] === "true")).toBeUndefined();
    expect(findElementByPredicate(tree, (element) => element.props?.role === "tablist")).toBeUndefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-save-tab")).toBeUndefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-split-right")).toBeUndefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-close-tab")).toBeUndefined();
    expect(findText(tree, "LSP: ready")).toBe(false);
    expect(findText(tree, "README.md")).toBe(false);
  });

  test("forwards Monaco content changes with the active tab id", () => {
    const calls: string[] = [];
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      tabs: [tab],
      activeTabId: tab.id,
      onChangeContent(tabId, content) {
        calls.push(`${tabId}:${content}`);
      },
    });

    const host = findElementByPredicate(tree, (element) => element.type === MonacoEditorHost);
    host?.props.onChange("const value = 2;\n");

    expect(calls).toEqual([`${tab.id}:const value = 2;\n`]);
  });

  test("renders diff tabs as the active editor content", () => {
    const diffTab: EditorTab = {
      kind: "diff",
      id: "diff::alpha",
      workspaceId,
      path: "src/a.ts ↔ src/b.ts",
      title: "a.ts ↔ b.ts",
      content: "",
      savedContent: "",
      version: "",
      dirty: false,
      saving: false,
      errorMessage: null,
      language: null,
      monacoLanguage: "plaintext",
      lspDocumentVersion: 0,
      diagnostics: [],
      lspStatus: null,
      readOnly: true,
      diff: {
        source: "compare",
        left: {
          workspaceId,
          path: "src/a.ts",
          title: "a.ts",
          content: "old",
          language: "typescript",
          monacoLanguage: "typescript",
        },
        right: {
          workspaceId,
          path: "src/b.ts",
          title: "b.ts",
          content: "new",
          language: "typescript",
          monacoLanguage: "typescript",
        },
      },
    };
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      active: true,
      tabs: [diffTab],
      activeTabId: diffTab.id,
      onChangeContent() {},
    });

    expect(findElementByPredicate(tree, (element) => element.type === DiffEditorHost)).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.type === MonacoEditorHost)).toBeUndefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-save-tab")).toBeUndefined();
  });

  test("renders file-open empty state without placeholder wording", () => {
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      tabs: [],
      activeTabId: null,
      onChangeContent() {},
    });

    expect(findText(tree, "No file open")).toBe(true);
    expect(findText(tree, "Open a file from the file tree to edit it.")).toBe(true);
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

    if (
      typeof node.type === "function" &&
      !["DiffEditorHost", "MonacoEditorHost"].includes(node.type.name)
    ) {
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
    if (node.type === DiffEditorHost) {
      return "";
    }

    if (
      typeof node.type === "function" &&
      !["MonacoEditorHost"].includes(node.type.name)
    ) {
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
