import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { ITabSetRenderValues, TabSetNode } from "flexlayout-react";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import type { EditorPaneState, EditorTab } from "../../services/editor-types";
import {
  createEditorGroupsOnRenderTabSetAdapter,
  type EditorGroupsOnRenderTabSetGroup,
} from "./onRenderTabSet-adapter";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("EditorGroups onRenderTabSet adapter", () => {
  test("renders Save for the active dirty file tab and invokes saveTab", () => {
    const dirtyFile = createEditorTab("file_dirty", "dirty.ts", true);
    const cleanFile = createEditorTab("file_clean", "clean.ts", false);
    const groups: EditorGroupsOnRenderTabSetGroup[] = [{
      id: "group_main",
      tabs: [
        { id: cleanFile.id, title: cleanFile.title, kind: "file", workspaceId, resourcePath: cleanFile.path },
        { id: dirtyFile.id, title: dirtyFile.title, kind: "file", workspaceId, resourcePath: dirtyFile.path },
      ],
      activeTabId: cleanFile.id,
    }];
    const panes: EditorPaneState[] = [{ id: "group_main", tabs: [cleanFile, dirtyFile], activeTabId: dirtyFile.id }];
    const saveCalls: string[] = [];
    const activatedGroups: string[] = [];
    const adapter = createEditorGroupsOnRenderTabSetAdapter({
      groups,
      panes,
      onActivateGroup(groupId) {
        activatedGroups.push(groupId);
      },
      onSaveTab(tabId) {
        saveCalls.push(tabId);
      },
      onSplitRight() {},
    });

    const values = renderTabSet(adapter, createTabSetNode("group_main", dirtyFile.id));
    const saveButton = findToolbarButton(values, "editor-save-tab");

    expect(saveButton).not.toBeNull();
    expect(saveButton?.props["data-tab-id"]).toBe(dirtyFile.id);
    invokeClick(saveButton);

    expect(activatedGroups).toEqual(["group_main"]);
    expect(saveCalls).toEqual([dirtyFile.id]);
  });

  test("hides Save for terminal and clean active tabs while keeping Split-right available", () => {
    const cleanFile = createEditorTab("file_clean", "clean.ts", false);
    const groups: EditorGroupsOnRenderTabSetGroup[] = [{
      id: "group_main",
      tabs: [
        { id: cleanFile.id, title: cleanFile.title, kind: "file", workspaceId, resourcePath: cleanFile.path },
        { id: "terminal_one", title: "Terminal", kind: "terminal", workspaceId, resourcePath: null },
      ],
      activeTabId: "terminal_one",
    }];
    const panes: EditorPaneState[] = [{ id: "group_main", tabs: [cleanFile], activeTabId: cleanFile.id }];
    const splitCalls: string[] = [];
    const adapter = createEditorGroupsOnRenderTabSetAdapter({
      groups,
      panes,
      onSaveTab(tabId) {
        throw new Error(`Save should be hidden, but received ${tabId}`);
      },
      onSplitRight() {
        splitCalls.push("right");
      },
    });

    const terminalValues = renderTabSet(adapter, createTabSetNode("group_main", "terminal_one"));
    expect(findToolbarButton(terminalValues, "editor-save-tab")).toBeNull();
    const splitButton = findToolbarButton(terminalValues, "editor-split-right");
    expect(splitButton).not.toBeNull();
    invokeClick(splitButton);

    const cleanValues = renderTabSet(adapter, createTabSetNode("group_main", cleanFile.id));
    expect(findToolbarButton(cleanValues, "editor-save-tab")).toBeNull();
    expect(findToolbarButton(cleanValues, "editor-split-right")).not.toBeNull();
    expect(splitCalls).toEqual(["right"]);
  });
});

function renderTabSet(
  adapter: (node: TabSetNode, renderValues: ITabSetRenderValues) => void,
  node: TabSetNode,
): ITabSetRenderValues {
  const renderValues: ITabSetRenderValues = {
    leading: null,
    stickyButtons: [],
    buttons: [],
    overflowPosition: undefined,
  };
  adapter(node, renderValues);
  return renderValues;
}

function createTabSetNode(groupId: string, selectedTabId: string | null): TabSetNode {
  return {
    getId: () => groupId,
    getSelectedNode: () => selectedTabId ? { getId: () => selectedTabId } : undefined,
  } as unknown as TabSetNode;
}

function createEditorTab(id: string, title: string, dirty: boolean): EditorTab {
  return {
    id,
    workspaceId,
    path: `src/${title}`,
    title,
    kind: "file",
    content: "",
    savedContent: dirty ? "saved" : "",
    version: "v1",
    dirty,
    saving: false,
    errorMessage: null,
    language: null,
    monacoLanguage: "typescript",
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
  };
}

function findToolbarButton(
  renderValues: ITabSetRenderValues,
  actionId: string,
): ReactElement<Record<string, unknown>> | null {
  return findElement([...renderValues.stickyButtons, ...renderValues.buttons], (element) =>
    element.props["data-action"] === actionId
  );
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | null {
  if (isReactElement(node)) {
    if (predicate(node)) {
      return node;
    }
    return findElement(node.props.children as ReactNode, predicate);
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) {
        return match;
      }
    }
  }

  return null;
}

function invokeClick(button: ReactElement<Record<string, unknown>> | null): void {
  const onClick = button?.props.onClick;
  if (typeof onClick !== "function") {
    throw new Error("Button is missing onClick handler");
  }
  onClick(createMouseEvent());
}

function isReactElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return typeof node === "object" && node !== null && "props" in node;
}

interface SyntheticMouseEvent {
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function createMouseEvent(): SyntheticMouseEvent {
  return {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}
