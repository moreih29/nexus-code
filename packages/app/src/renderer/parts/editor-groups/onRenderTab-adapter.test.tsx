import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { ITabRenderValues, TabNode } from "flexlayout-react";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import type { EditorPaneState, EditorTab } from "../../services/editor-types";
import {
  createEditorGroupsOnRenderTabAdapter,
  createEditorGroupsOnRenderTabLookups,
  createEditorGroupsOnRenderTabState,
  formatTerminalTabLabel,
  type EditorGroupsOnRenderTabGroup,
} from "./onRenderTab-adapter";

const workspaceId = "ws_alpha" as WorkspaceId;

describe("EditorGroups onRenderTab adapter", () => {
  test("renders clean and dirty file labels with a file-only dirty indicator", () => {
    const cleanFile = createEditorTab("file_clean", "clean.ts", false);
    const dirtyFile = createEditorTab("file_dirty", "dirty.ts", true);
    const groups: EditorGroupsOnRenderTabGroup[] = [{
      id: "group_main",
      tabs: [
        { id: cleanFile.id, title: cleanFile.title, kind: "file", workspaceId, resourcePath: cleanFile.path },
        { id: dirtyFile.id, title: dirtyFile.title, kind: "file", workspaceId, resourcePath: dirtyFile.path },
      ],
      activeTabId: dirtyFile.id,
    }];
    const panes: EditorPaneState[] = [{ id: "group_main", tabs: [cleanFile, dirtyFile], activeTabId: dirtyFile.id }];
    const adapter = createEditorGroupsOnRenderTabAdapter({ groups, panes, onCloseTab() {} });

    const cleanValues = renderTab(adapter, createTabNode(cleanFile.id, cleanFile.title, groups[0]!));
    const dirtyValues = renderTab(adapter, createTabNode(dirtyFile.id, dirtyFile.title, groups[0]!));

    expect(extractLabel(cleanValues.content)).toBe("clean.ts");
    expect(findElement(cleanValues.content, (element) => element.props["data-editor-tab-dirty"] === "true")).toBeNull();
    expect(extractLabel(dirtyValues.content)).toBe("dirty.ts");
    expect(findElement(dirtyValues.content, (element) => element.props["data-editor-tab-dirty"] === "true")).not.toBeNull();
    expect(dirtyValues.name).toBe("dirty.ts");
  });

  test("renders terminal tabs with SquareTerminal shell/cwd label and fallback label without dirty state", () => {
    const groups: EditorGroupsOnRenderTabGroup[] = [{
      id: "group_main",
      tabs: [
        { id: "terminal_one", title: "Terminal", kind: "terminal", workspaceId, resourcePath: null },
        { id: "terminal_two", title: "Terminal", kind: "terminal", workspaceId, resourcePath: null },
      ],
      activeTabId: "terminal_two",
    }];
    const panes: EditorPaneState[] = [{ id: "group_main", tabs: [], activeTabId: null }];
    const adapter = createEditorGroupsOnRenderTabAdapter({ groups, panes, onCloseTab() {} });
    const terminalConfig = {
      editorGroupTab: { id: "terminal_one", title: "Terminal", kind: "terminal", workspaceId, resourcePath: null },
      terminal: { shell: "/bin/zsh", cwd: "/Users/kih/workspaces/nexus-code" },
    };

    const metadataValues = renderTab(adapter, createTabNode("terminal_one", "Terminal", groups[0]!, terminalConfig));
    const fallbackValues = renderTab(adapter, createTabNode("terminal_two", "Terminal", groups[0]!));

    expect(extractLabel(metadataValues.content)).toBe("zsh—nexus-code");
    expect(findElement(metadataValues.content, (element) => element.props["data-editor-layout-tab-terminal-icon"] === "true")).not.toBeNull();
    expect(findElement(metadataValues.content, (element) => element.props["data-editor-tab-dirty"] === "true")).toBeNull();
    expect(metadataValues.name).toBe("zsh—nexus-code");
    expect(extractLabel(fallbackValues.content)).toBe("Terminal 2");
    expect(fallbackValues.name).toBe("Terminal 2");
  });

  test("keeps context menu and middle-click close wired to flexlayout tab state", () => {
    const first = createEditorTab("file_first", "first.ts", false);
    const second = createEditorTab("file_second", "second.ts", false);
    const terminal = { id: "terminal_one", title: "Terminal", kind: "terminal" };
    const groups: EditorGroupsOnRenderTabGroup[] = [{
      id: "group_main",
      tabs: [
        { id: first.id, title: first.title, kind: "file", workspaceId, resourcePath: first.path },
        { id: second.id, title: second.title, kind: "file", workspaceId, resourcePath: second.path },
        terminal,
      ],
      activeTabId: first.id,
    }];
    const panes: EditorPaneState[] = [{ id: "group_main", tabs: [first, second], activeTabId: first.id }];
    const closeCalls: string[] = [];
    const splitCalls: string[] = [];
    const adapter = createEditorGroupsOnRenderTabAdapter({
      groups,
      panes,
      onCloseTab(groupId, tabId) {
        closeCalls.push(`${groupId}:${tabId}`);
      },
      onCopyTabPath() {},
      onRevealTabInFinder() {},
      onSplitTabRight(groupId, tabId) {
        splitCalls.push(`${groupId}:${tabId}`);
      },
    });

    const values = renderTab(adapter, createTabNode(first.id, first.title, groups[0]!));
    const menu = values.content as ReactElement<{
      actionIds?: readonly string[];
      children: ReactNode;
      onCloseTabsToRight?: () => void;
      onSplitRight?: () => void;
    }>;
    expect(menu.props.actionIds).toEqual([
      "close",
      "close-others",
      "close-right",
      "close-all",
      "copy-path",
      "copy-relative-path",
      "reveal",
      "split-right",
    ]);
    menu.props.onCloseTabsToRight?.();
    menu.props.onSplitRight?.();
    const surface = menu.props.children as ReactElement<{ onMouseDown(event: MiddleMouseEvent): void }>;
    const middleMouseEvent = createMiddleMouseEvent();
    surface.props.onMouseDown(middleMouseEvent);

    expect(closeCalls).toEqual([
      `group_main:${second.id}`,
      "group_main:terminal_one",
      `group_main:${first.id}`,
    ]);
    expect(splitCalls).toEqual([`group_main:${first.id}`]);
    expect(middleMouseEvent.defaultPrevented).toBe(true);
    expect(middleMouseEvent.propagationStopped).toBe(true);
  });

  test("resolves terminal fallback labels from config metadata before ordinals", () => {
    expect(formatTerminalTabLabel({
      tabId: "terminal_alpha",
      title: "Terminal",
      config: { editorGroupTab: { terminalMetadata: { terminalNumber: 7 } } },
      terminalOrdinal: 2,
    })).toBe("Terminal 7");

    const state = createEditorGroupsOnRenderTabState(
      createTabNode("terminal_alpha", "Terminal", {
        id: "group_main",
        tabs: [{ id: "terminal_alpha", title: "Terminal", kind: "terminal" }],
        activeTabId: "terminal_alpha",
      }),
      createEditorGroupsOnRenderTabLookups([{
        id: "group_main",
        tabs: [{ id: "terminal_alpha", title: "Terminal", kind: "terminal" }],
        activeTabId: "terminal_alpha",
      }], []),
    );

    expect(state.label).toBe("Terminal 1");
    expect(state.contextActionIds).toEqual(["close", "close-others", "close-right", "close-all"]);
  });
});

function renderTab(
  adapter: (node: TabNode, renderValues: ITabRenderValues) => void,
  node: TabNode,
): ITabRenderValues & { name?: string } {
  const renderValues: ITabRenderValues & { name?: string } = {
    leading: null,
    content: null,
    buttons: [],
  };
  adapter(node, renderValues);
  return renderValues;
}

function createTabNode(
  id: string,
  name: string,
  group: EditorGroupsOnRenderTabGroup,
  config: unknown = { editorGroupTab: group.tabs.find((tab) => tab.id === id) },
): TabNode {
  return {
    getId: () => id,
    getName: () => name,
    getConfig: () => config,
    getParent: () => ({ getId: () => group.id }),
  } as unknown as TabNode;
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

function extractLabel(node: ReactNode): string | null {
  const label = findElement(node, (element) => element.props["data-editor-layout-tab-label"] === "true");
  return typeof label?.props.children === "string" ? label.props.children : null;
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

function isReactElement(node: ReactNode): node is ReactElement<Record<string, unknown>> {
  return typeof node === "object" && node !== null && "props" in node;
}

interface MiddleMouseEvent {
  button: number;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function createMiddleMouseEvent(): MiddleMouseEvent {
  return {
    button: 1,
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
