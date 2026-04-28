import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorPaneState, EditorTab } from "../stores/editor-store";
import {
  DEFAULT_EDITOR_SPLIT_RATIO,
  EDITOR_SPLIT_PANE_MIN_WIDTH,
  EDITOR_SPLIT_RATIO_STORAGE_KEY,
  MAX_EDITOR_SPLIT_RATIO,
  MIN_EDITOR_SPLIT_RATIO,
  SplitEditorPaneView,
  clampEditorSplitRatio,
  editorSplitRatioFromPointerDrag,
  nextEditorSplitRatioFromKeyboard,
  parseEditorSplitRatio,
  persistEditorSplitRatio,
  readStoredEditorSplitRatio,
} from "./SplitEditorPane";

const workspaceId = "ws_alpha" as WorkspaceId;

afterEach(() => {
  globalThis.localStorage?.removeItem(EDITOR_SPLIT_RATIO_STORAGE_KEY);
});

describe("SplitEditorPane", () => {
  test("renders a vertical resize divider between two editor panes and wires pane-scoped tab actions", () => {
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

    const tree = SplitEditorPaneView({
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

    const resizeHandle = findElementByPredicate(tree, (element) => element.props?.role === "separator");
    expect(resizeHandle?.props["aria-orientation"]).toBe("vertical");
    expect(resizeHandle?.props["aria-label"]).toBe("Resize editor split");
    expect(resizeHandle?.props["aria-valuemin"]).toBe(MIN_EDITOR_SPLIT_RATIO * 100);
    expect(resizeHandle?.props["aria-valuemax"]).toBe(MAX_EDITOR_SPLIT_RATIO * 100);
    expect(resizeHandle?.props["aria-valuenow"]).toBe(DEFAULT_EDITOR_SPLIT_RATIO * 100);
    expect(resizeHandle?.props["data-resize-handle-state"]).toBe("inactive");
    expect(String(resizeHandle?.props.className)).toContain("cursor-col-resize");
    expect(
      String(findElementByPredicate(tree, (element) => element.props?.["data-editor-split-pane"] === "p1")?.props.className),
    ).not.toContain("border-l border-border");

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

  test("applies split ratio flex-basis and drag state to two panes", () => {
    const panes: EditorPaneState[] = [
      {
        id: "p0",
        tabs: [createTab("src/left.ts")],
        activeTabId: `${workspaceId}::src/left.ts`,
      },
      {
        id: "p1",
        tabs: [createTab("src/right.ts")],
        activeTabId: `${workspaceId}::src/right.ts`,
      },
    ];

    const tree = SplitEditorPaneView({
      ...baseProps(),
      panes,
      splitRatio: 0.65,
      splitDragging: true,
    });

    const leftPane = findElementByPredicate(tree, (element) => element.props?.["data-editor-split-pane"] === "p0");
    const rightPane = findElementByPredicate(tree, (element) => element.props?.["data-editor-split-pane"] === "p1");
    const resizeHandle = findElementByPredicate(tree, (element) => element.props?.role === "separator");

    expect(leftPane?.props.style.flexBasis).toBe("65%");
    expect(leftPane?.props.style.minWidth).toBe(EDITOR_SPLIT_PANE_MIN_WIDTH);
    expect(rightPane?.props.style.flexBasis).toBe("35%");
    expect(rightPane?.props.style.minWidth).toBe(EDITOR_SPLIT_PANE_MIN_WIDTH);
    expect(resizeHandle?.props["aria-valuenow"]).toBe(65);
    expect(resizeHandle?.props["data-resize-handle-state"]).toBe("drag");
  });

  test("clamps parser, pointer drag, and keyboard ratio changes", () => {
    expect(parseEditorSplitRatio(null)).toBe(DEFAULT_EDITOR_SPLIT_RATIO);
    expect(parseEditorSplitRatio("bad ratio")).toBe(DEFAULT_EDITOR_SPLIT_RATIO);
    expect(parseEditorSplitRatio("0.1")).toBe(MIN_EDITOR_SPLIT_RATIO);
    expect(parseEditorSplitRatio("0.9")).toBe(MAX_EDITOR_SPLIT_RATIO);
    expect(clampEditorSplitRatio(0.1, null)).toBe(MIN_EDITOR_SPLIT_RATIO);
    expect(clampEditorSplitRatio(0.9, null)).toBe(MAX_EDITOR_SPLIT_RATIO);
    expect(clampEditorSplitRatio(0.2, 1_000)).toBe(EDITOR_SPLIT_PANE_MIN_WIDTH / 1_000);
    expect(clampEditorSplitRatio(0.8, 1_000)).toBe(1 - EDITOR_SPLIT_PANE_MIN_WIDTH / 1_000);
    expect(clampEditorSplitRatio(0.7, 400)).toBe(DEFAULT_EDITOR_SPLIT_RATIO);
    expect(editorSplitRatioFromPointerDrag(0.5, 100, 260, 800)).toBe(0.7);
    expect(nextEditorSplitRatioFromKeyboard(0.5, "ArrowRight", 800)).toBe(0.52);
    expect(nextEditorSplitRatioFromKeyboard(0.5, "ArrowLeft", 800)).toBe(0.48);
    expect(nextEditorSplitRatioFromKeyboard(0.5, "Enter", 800)).toBeNull();
  });

  test("renders a single editor pane without a divider", () => {
    const panes: EditorPaneState[] = [
      {
        id: "p0",
        tabs: [createTab("src/index.ts")],
        activeTabId: `${workspaceId}::src/index.ts`,
      },
    ];

    const tree = SplitEditorPaneView({
      ...baseProps(),
      panes,
      splitRatio: 0.3,
    });

    expect(findElementsByPredicate(tree, (element) => element.props?.["data-editor-split-pane"])).toHaveLength(1);
    expect(findElementByPredicate(tree, (element) => element.props?.role === "separator")).toBeUndefined();
    expect(findElementByPredicate(tree, (element) => element.props?.["data-editor-split-pane"] === "p0")?.props.style.flexBasis).toBe("100%");
  });

  test("reads and writes persisted split ratio from localStorage", () => {
    const storage = installMemoryLocalStorage();

    expect(readStoredEditorSplitRatio()).toBe(DEFAULT_EDITOR_SPLIT_RATIO);
    storage.setItem(EDITOR_SPLIT_RATIO_STORAGE_KEY, "0.72");
    expect(readStoredEditorSplitRatio()).toBe(0.72);
    storage.setItem(EDITOR_SPLIT_RATIO_STORAGE_KEY, "invalid");
    expect(readStoredEditorSplitRatio()).toBe(DEFAULT_EDITOR_SPLIT_RATIO);

    persistEditorSplitRatio(0.9);
    expect(storage.getItem(EDITOR_SPLIT_RATIO_STORAGE_KEY)).toBe(String(MAX_EDITOR_SPLIT_RATIO));
  });

  test("renders dirty indicators in both split panes for the same dirty file", () => {
    const tab = {
      ...createTab("src/index.ts"),
      dirty: true,
    };
    const panes: EditorPaneState[] = [
      {
        id: "p0",
        tabs: [tab],
        activeTabId: tab.id,
      },
      {
        id: "p1",
        tabs: [tab],
        activeTabId: tab.id,
      },
    ];

    const tree = SplitEditorPaneView({
      ...baseProps(),
      panes,
    });

    expect(
      findElementsByPredicate(
        tree,
        (element) => element.props?.["data-editor-tab-dirty"] === "true",
      ),
    ).toHaveLength(2);
  });
});

function baseProps(): Omit<Parameters<typeof SplitEditorPaneView>[0], "panes"> {
  return {
    activeWorkspaceId: workspaceId,
    activeWorkspaceName: "Alpha",
    activePaneId: "p0",
    onActivatePane() {},
    onSplitRight() {},
    onActivateTab() {},
    onCloseTab() {},
    onSaveTab() {},
    onChangeContent() {},
  };
}

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

function installMemoryLocalStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Storage;

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  return storage;
}
