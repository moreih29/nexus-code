import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorTab } from "../services/editor-types";
import { DiffEditorHost } from "./DiffEditorHost";
import { EditorPaneView } from "./EditorPane";
import { MonacoEditorHost } from "./MonacoEditorHost";
import { TabContextMenu } from "./tab-context-menu";

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
  test("renders a single tab bar with dirty indicator, save, close, Monaco host, and LSP status", () => {
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      active: true,
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
    const paneClassName = String(findElementByPredicate(tree, (element) => element.props?.["data-component"] === "editor-pane")?.props.className);
    expect(paneClassName).not.toContain("ring-1 ring-inset");
    expect(paneClassName).toContain("focus-visible:outline-1");
    expect(paneClassName).toContain("focus-visible:outline-offset-[-1px]");
    expect(paneClassName).toContain("has-[:focus-visible]:outline-1");
    expect(String(findElementByPredicate(tree, (element) => element.props?.["data-editor-pane-header"] === "true")?.props.className)).toContain("bg-zinc-600");
    expect(String(findElementByPredicate(tree, (element) => element.props?.["data-editor-tab-title-active"] === "true")?.props.className)).toContain("font-semibold text-foreground");
    expect(findElementByPredicate(tree, (element) => element.type === MonacoEditorHost)).toBeDefined();
  });

  test("mutes the active tab title when the editor pane is inactive", () => {
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      active: false,
      tabs: [tab],
      activeTabId: tab.id,
      onActivateTab() {},
      onCloseTab() {},
      onSaveTab() {},
      onChangeContent() {},
    });

    const titleClassName = String(
      findElementByPredicate(
        tree,
        (element) => element.props?.["data-editor-tab-title-active"] === "true",
      )?.props.className,
    );
    const headerClassName = String(
      findElementByPredicate(
        tree,
        (element) => element.props?.["data-editor-pane-header"] === "true",
      )?.props.className,
    );
    expect(headerClassName).toContain("bg-card/60");
    expect(titleClassName).toContain("font-normal text-muted-foreground");
    expect(titleClassName).not.toContain("font-semibold text-foreground");
  });

  test("keeps inactive tab titles muted even in the active editor pane", () => {
    const inactiveTab: EditorTab = {
      ...tab,
      id: "ws_alpha::README.md",
      path: "README.md",
      title: "README.md",
      dirty: false,
      diagnostics: [],
    };
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      active: true,
      tabs: [tab, inactiveTab],
      activeTabId: tab.id,
      onActivateTab() {},
      onCloseTab() {},
      onSaveTab() {},
      onChangeContent() {},
    });

    expect(String(findElementByPredicate(tree, (element) => element.props?.["data-editor-tab-title-active"] === "false")?.props.className)).toContain("font-normal text-muted-foreground");
  });

  test("renders a 1px primary drop indicator between tabs during tab drag", () => {
    const inactiveTab: EditorTab = {
      ...tab,
      id: "ws_alpha::README.md",
      path: "README.md",
      title: "README.md",
      dirty: false,
      diagnostics: [],
    };
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      active: true,
      tabs: [tab, inactiveTab],
      activeTabId: tab.id,
      tabDropIndicatorIndex: 1,
      onActivateTab() {},
      onCloseTab() {},
      onSaveTab() {},
      onChangeContent() {},
    });

    const indicator = findElementByPredicate(
      tree,
      (element) => element.props?.["data-editor-tab-drop-indicator"] === "true",
    );
    expect(indicator).toBeDefined();
    expect(String(indicator?.props.className)).toContain("w-px");
    expect(String(indicator?.props.className)).toContain("bg-primary");
  });

  test("renders diff tabs with GitCompare title, read-only badge, and DiffEditorHost", () => {
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
      onActivateTab() {},
      onCloseTab() {},
      onSaveTab() {},
      onChangeContent() {},
    });

    expect(findText(tree, "a.ts ↔ b.ts")).toBe(true);
    expect(findText(tree, "Read-only")).toBe(true);
    expect(findText(tree, "j/k change navigation")).toBe(true);
    expect(findElementByPredicate(tree, (element) => element.props?.["data-editor-tab-kind"] === "diff")).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.type === DiffEditorHost)).toBeDefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-save-tab")).toBeUndefined();
  });

  test("wraps editor tabs in a tab context menu and forwards file-action handlers", () => {
    const calls: string[] = [];
    const tree = EditorPaneView({
      activeWorkspaceName: "Alpha",
      active: true,
      tabs: [tab],
      activeTabId: tab.id,
      onActivateTab() {},
      onCloseTab() {},
      onCloseOtherTabs(tabId) {
        calls.push(`close-others:${tabId}`);
      },
      onCloseTabsToRight(tabId) {
        calls.push(`close-right:${tabId}`);
      },
      onCloseAllTabs() {
        calls.push("close-all");
      },
      onCopyTabPath(tab, pathKind) {
        calls.push(`copy:${pathKind}:${tab.path}`);
      },
      onRevealTabInFinder(tab) {
        calls.push(`reveal:${tab.path}`);
      },
      onTearOffTabToFloating(tabId) {
        calls.push(`tear-off:${tabId}`);
      },
      onSplitRight() {
        calls.push("split");
      },
      onSaveTab() {},
      onChangeContent() {},
    });

    const menu = findElementByPredicate(tree, (element) => element.type === TabContextMenu);

    expect(menu?.props.paneId).toBe("p0");
    expect(menu?.props.tab).toMatchObject({ id: tab.id, path: "src/index.ts" });
    expect(menu?.props.tabs).toHaveLength(1);

    menu?.props.onCloseOtherTabs("p0", tab.id);
    menu?.props.onCloseTabsToRight("p0", tab.id);
    menu?.props.onCloseAllTabs("p0");
    menu?.props.onCopyPath(tab, "relative");
    menu?.props.onRevealInFinder(tab);
    menu?.props.onTearOffToFloating("p0", tab.id);
    menu?.props.onSplitRight(tab);

    expect(calls).toEqual([
      `close-others:${tab.id}`,
      `close-right:${tab.id}`,
      "close-all",
      "copy:relative:src/index.ts",
      "reveal:src/index.ts",
      `tear-off:${tab.id}`,
      "split",
    ]);
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

    if (
      typeof node.type === "function" &&
      !["DiffEditorHost", "MonacoEditorHost", "TabContextMenu", "ContextMenu"].includes(node.type.name)
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
      !["MonacoEditorHost", "TabContextMenu", "ContextMenu"].includes(node.type.name)
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
