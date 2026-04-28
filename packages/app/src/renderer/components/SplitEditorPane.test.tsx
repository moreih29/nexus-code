import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorPaneState, EditorTab } from "../stores/editor-store";
import { SplitEditorPane } from "./SplitEditorPane";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("SplitEditorPane", () => {
  test("renders one-depth horizontal editor panes and wires pane-scoped tab actions", () => {
    const tab = createTab("src/index.ts");
    const calls: string[] = [];
    const panes: EditorPaneState[] = [
      {
        id: "p0",
        tabs: [tab],
        activeTabId: tab.id,
      },
      {
        id: "p1",
        tabs: [],
        activeTabId: null,
      },
    ];

    const tree = SplitEditorPane({
      activeWorkspaceId: workspaceId,
      activeWorkspaceName: "Alpha",
      panes,
      activePaneId: "p0",
      onActivatePane: (paneId) => calls.push(`activate-pane:${paneId}`),
      onSplitRight: () => calls.push("split"),
      onActivateTab: (paneId, tabId) => calls.push(`activate-tab:${paneId}:${tabId}`),
      onCloseTab: (paneId, tabId) => calls.push(`close-tab:${paneId}:${tabId}`),
      onSaveTab: (tabId) => calls.push(`save:${tabId}`),
      onChangeContent: (tabId) => calls.push(`change:${tabId}`),
    });

    expect(findElementsByPredicate(tree, (element) => element.props?.["data-editor-split-pane"])).toHaveLength(2);
    expect(String(findElementByPredicate(tree, (element) => element.props?.["data-editor-split-pane"] === "p1")?.props.className)).toContain("border-l border-border");

    const splitButton = findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-split-right");
    expect(splitButton?.props.variant).toBe("ghost");
    expect(splitButton?.props.className).toContain("h-7 w-7");
    expect(splitButton?.props.title).toBe("Split right (⌘\\)");
    splitButton?.props.onClick();
    expect(calls).toContain("split");

    const closeButton = findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-close-tab");
    closeButton?.props.onClick();
    expect(calls).toContain(`close-tab:p0:${tab.id}`);
  });
});

function createTab(path: string): EditorTab {
  return {
    id: `${workspaceId}::${path}`,
    workspaceId,
    path,
    title: path.split("/").at(-1) ?? path,
    content: "const value = 1;\n",
    savedContent: "const value = 1;\n",
    version: "v1",
    dirty: false,
    saving: false,
    errorMessage: null,
    language: "typescript",
    monacoLanguage: "typescript",
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
  };
}

function findElementByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | undefined {
  return findElementsByPredicate(node, predicate)[0];
}

function findElementsByPredicate(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement[] {
  if (isReactElement(node)) {
    const matches = predicate(node) ? [node] : [];

    if (typeof node.type === "function" && node.type.name !== "MonacoEditorHost") {
      return [...matches, ...findElementsByPredicate(node.type(node.props), predicate)];
    }

    return [...matches, ...findElementsByPredicate(node.props.children, predicate)];
  }

  if (Array.isArray(node)) {
    return node.flatMap((child) => findElementsByPredicate(child, predicate));
  }

  return [];
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}
