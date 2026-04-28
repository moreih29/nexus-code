import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorTab } from "../stores/editor-store";
import { EditorPaneView } from "./EditorPane";
import { MonacoEditorHost } from "./MonacoEditorHost";

const workspaceId = "ws_alpha" as WorkspaceId;
const tab: EditorTab = {
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
  test("renders a single tab bar with dirty indicator, save, close, Monaco host, and LSP status", () => {
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      tabs: [tab],
      activeTabId: tab.id,
      onActivateTab() {},
      onCloseTab() {},
      onSaveTab() {},
      onChangeContent() {},
    });

    expect(findText(tree, "index.ts")).toBe(true);
    expect(findText(tree, "Save")).toBe(true);
    expect(findText(tree, "LSP: ready")).toBe(true);
    expect(findText(tree, "1 errors · 0 warnings")).toBe(true);
    expect(findElementByPredicate(tree, (element) => element.props?.["data-editor-tab-dirty"] === "true")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-close-tab")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-split-right")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-save-tab")).toBeDefined();
    expect(String(findElementByPredicate(tree, (element) => element.props?.["data-component"] === "editor-pane")?.props.className)).toContain("ring-1 ring-inset ring-[var(--color-ring)]");
    expect(String(findElementByPredicate(tree, (element) => element.props?.["data-editor-tab-title-active"] === "true")?.props.className)).toContain("font-semibold text-foreground");
    expect(findElementByPredicate(tree, (element) => element.type === MonacoEditorHost)).toBeDefined();
  });

  test("renders file-open empty state without placeholder wording", () => {
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      tabs: [],
      activeTabId: null,
      onActivateTab() {},
      onCloseTab() {},
      onSaveTab() {},
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
