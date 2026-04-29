import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorPaneState, EditorTab } from "../services/editor-types";
import { SplitEditorPaneView } from "./SplitEditorPane";

const workspaceId = "ws_alpha" as WorkspaceId;
const otherWorkspaceId = "ws_beta" as WorkspaceId;

describe("SplitEditorPane compatibility host", () => {
  test("renders the active pane without legacy split grid or splitter markup", () => {
    const tab = createTab("src/index.ts");
    const calls: string[] = [];
    const tree = SplitEditorPaneView({
      ...baseProps(calls),
      panes: [
        { id: "p0", tabs: [tab], activeTabId: tab.id },
        { id: "p1", tabs: [createTab("src/right.ts")], activeTabId: `${workspaceId}::src/right.ts` },
      ],
      activePaneId: "p0",
    });

    expect(findElementByPredicate(tree, (element) => element.props?.["data-component"] === "split-editor-pane-compat")).toBeDefined();
    expect(findElementsByPredicate(tree, (element) => element.props?.["data-editor-split-pane"] !== undefined)).toHaveLength(0);
    expect(findElementByPredicate(tree, (element) => element.props?.role === "separator")).toBeUndefined();

    const splitButton = findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-split-right");
    splitButton?.props.onClick();
    expect(calls).toContain("split");

    const closeButton = findElementByPredicate(tree, (element) => element.props?.["data-action"] === "editor-close-tab");
    closeButton?.props.onClick();
    expect(calls).toContain(`close:p0:${tab.id}`);
  });

  test("filters active-pane tabs to the active workspace", () => {
    const activeTab = createTab("한글.ts");
    const hiddenTab = createTab("beta.ts", otherWorkspaceId);
    const tree = SplitEditorPaneView({
      ...baseProps(),
      panes: [
        { id: "p0", tabs: [activeTab, hiddenTab], activeTabId: activeTab.id },
      ],
      activePaneId: "p0",
    });

    const tabTitles = findElementsByPredicate(tree, (element) => element.props?.["data-editor-tab-title-active"] !== undefined);

    expect(tabTitles.map((element) => textContent(element))).toEqual(["한글.ts"]);
  });
});

function baseProps(calls: string[] = []): Omit<Parameters<typeof SplitEditorPaneView>[0], "panes"> {
  return {
    activeWorkspaceId: workspaceId,
    activeWorkspaceName: "Alpha",
    activePaneId: "p0",
    onActivatePane: (paneId) => calls.push(`activate-pane:${paneId}`),
    onSplitRight: () => calls.push("split"),
    onReorderTab() {},
    onMoveTabToPane() {},
    onSplitTabRight() {},
    onActivateTab: (paneId, tabId) => calls.push(`activate:${paneId}:${tabId}`),
    onCloseTab: (paneId, tabId) => calls.push(`close:${paneId}:${tabId}`),
    onSaveTab: (tabId) => calls.push(`save:${tabId}`),
    onChangeContent: (tabId) => calls.push(`change:${tabId}`),
  };
}

function createTab(path: string, tabWorkspaceId: WorkspaceId = workspaceId): EditorTab {
  return {
    kind: "file",
    id: `${tabWorkspaceId}::${path}`,
    workspaceId: tabWorkspaceId,
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

    if (
      typeof node.type === "function" &&
      !["MonacoEditorHost", "TabContextMenu", "ContextMenu"].includes(node.type.name)
    ) {
      return matches.concat(findElementsByPredicate(node.type(node.props), predicate));
    }

    return matches.concat(findElementsByPredicate(node.props.children, predicate));
  }

  if (Array.isArray(node)) {
    return node.flatMap((child) => findElementsByPredicate(child, predicate));
  }

  return [];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (isReactElement(node)) {
    return textContent(node.props.children);
  }

  if (Array.isArray(node)) {
    return node.map(textContent).join("");
  }

  return "";
}

function isReactElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "props" in node;
}
