/**
 * Integration: split-duplicate end-to-end verification
 *
 * SCOPE
 * -----
 * Scenario B — openOrRevealEditor newSplit on empty layout (ensureLayout auto-call)
 *   B3. tabsStore gains exactly one new tab record
 *   (B1/B2, openTabInNewSplit on an empty layout, are covered by
 *    operations.test.ts Scenario 10.)
 *
 * Scenario C — FileTree plain-Enter / Space branching (dir vs file)
 *   C3. File node + Enter routes to openOrRevealEditor
 *   C4. Dir node + Enter calls toggleExpand, not openOrRevealEditor
 *   (Cmd+Enter / open-to-side moved to the global dispatcher in Phase 3
 *    and is covered by `tests/unit/renderer/keybindings/dispatcher.test.ts`.)
 *
 * Scenario D — useGroupActions.splitRight/splitDown → service newSplit state
 *   D1. splitRight produces a second leaf, source tab unchanged
 *   D2. splitDown produces a vertical split leaf
 *   D3. Two tab records exist in tabsStore after splitRight
 *   D4. Empty contextTabId is a no-op (guard branch)
 *
 * AUTOMATION BOUNDARIES
 * ---------------------
 * What IS automated:
 *   - Store-level state changes for split + duplicate operations
 *   - openOrRevealEditor newSplit on an empty workspace (ensureLayout path)
 *   - handleKeyDown logic extracted as inline handler mirrors (no DOM/React)
 *   - useGroupActions split dispatch (a plain factory, called directly)
 *
 * What is NOT automated (DOM/Electron boundary):
 *   - React rendering of the FileTree virtualizer
 *   - PTY process spawn per new split
 *   - CSS visibility / layout measurement
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shim window.ipc so store modules load without DOM / Electron preload.
// Must happen before any store import.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Mock ipcCallResult
// ---------------------------------------------------------------------------

mock.module("../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import { openOrRevealEditor } from "../../src/renderer/services/editor";
import {
  createFileTreeKeydownHandler,
  type FileTreeKeydownDeps,
} from "../../src/renderer/components/files/keys";
import { useGroupActions } from "../../src/renderer/components/workspace/group/use-group-actions";
import { openTerminalTab } from "../../src/renderer/state/operations";
import { useLayoutStore } from "../../src/renderer/state/stores/layout";
import { allLeaves, findLeaf } from "../../src/renderer/state/stores/layout/helpers";
import { useTabsStore } from "../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

function resetStores() {
  useTabsStore.setState({ byWorkspace: {} });
  useLayoutStore.setState({ byWorkspace: {} });
}

function getLayout() {
  const layout = useLayoutStore.getState().byWorkspace[WS];
  if (!layout) throw new Error(`layout slice not found for ${WS}`);
  return layout;
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`expected ${label}`);
  return value;
}

// ---------------------------------------------------------------------------
// Scenario B — openOrRevealEditor newSplit on empty layout
// (openTabInNewSplit on an empty layout is covered by operations.test.ts
//  Scenario 10.)
// ---------------------------------------------------------------------------

describe("Scenario B3: openOrRevealEditor newSplit on empty layout creates one editor tab", () => {
  beforeEach(resetStores);

  it("tabsStore gains exactly one tab on empty workspace", () => {
    const result = openOrRevealEditor(
      { workspaceId: WS, filePath: "/index.ts" },
      { newSplit: { orientation: "horizontal", side: "after" } },
    );

    const wsRecord = useTabsStore.getState().byWorkspace[WS];
    const tabs = must(wsRecord, "workspace tabs");
    expect(Object.keys(tabs).length).toBe(1);
    expect(tabs[result.tabId]).toBeDefined();
    expect(tabs[result.tabId]?.type).toBe("editor");
  });
});

// ---------------------------------------------------------------------------
// Scenario C — FileTree plain-Enter branching (dir vs file)
//
// createFileTreeKeydownHandler is the real production handler (exported from
// keys.ts). Its openOrRevealEditor / toggleExpand deps are injectable so we
// inject mocks and exercise the actual branch logic. Breaking the Enter branch
// in keys.ts will cause these tests to fail.
// ---------------------------------------------------------------------------

/** Minimal React-like synthetic key event accepted by createFileTreeKeydownHandler. */
function makeSyntheticKeyEvent(key: string): React.KeyboardEvent<HTMLDivElement> {
  let prevented = false;
  // nativeEvent is only used by evaluateContextKey("inputFocus"/"editorFocus", ke)
  // which inspects ke.target. A null target passes the guard (not in any input/editor).
  const nativeEvent = { key, target: null } as unknown as KeyboardEvent;
  return {
    key,
    nativeEvent,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  } as unknown as React.KeyboardEvent<HTMLDivElement>;
}

/** Minimal FlatItem for an Enter-key routing test. */
function makeFlatItem(absPath: string, type: "file" | "dir") {
  return {
    absPath,
    depth: 0,
    node: {
      absPath,
      name: absPath.split("/").pop() ?? absPath,
      type,
      childrenLoaded: true,
      children: [],
    },
  };
}

describe("Scenario C3: FileTree plain Enter on a file calls openOrRevealEditor", () => {
  it("routes to openOrRevealEditor for a file on plain Enter", () => {
    const openOrRevealEditorMock = mock(() => {});
    const toggleExpandMock = mock(() => {});

    const deps: FileTreeKeydownDeps = {
      flat: [makeFlatItem("/proj/README.md", "file")],
      tree: undefined,
      workspaceId: "ws-1",
      rootAbsPath: "/proj",
      activeIndex: 0,
      setActiveIndex: () => {},
      scrollToIndex: () => {},
      openOrRevealEditor: openOrRevealEditorMock,
      toggleExpand: toggleExpandMock,
    };

    const handler = createFileTreeKeydownHandler(deps);
    const e = makeSyntheticKeyEvent("Enter");
    handler(e);

    expect(openOrRevealEditorMock).toHaveBeenCalledTimes(1);
    expect(openOrRevealEditorMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      filePath: "/proj/README.md",
    });
    expect(toggleExpandMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("Scenario C4: FileTree plain Enter on a dir calls toggleExpand, not openOrRevealEditor", () => {
  it("routes to toggleExpand for a directory on plain Enter", () => {
    const openOrRevealEditorMock = mock(() => {});
    const toggleExpandMock = mock(() => {});

    const deps: FileTreeKeydownDeps = {
      flat: [makeFlatItem("/proj/src", "dir")],
      tree: undefined,
      workspaceId: "ws-1",
      rootAbsPath: "/proj",
      activeIndex: 0,
      setActiveIndex: () => {},
      scrollToIndex: () => {},
      openOrRevealEditor: openOrRevealEditorMock,
      toggleExpand: toggleExpandMock,
    };

    const handler = createFileTreeKeydownHandler(deps);
    const e = makeSyntheticKeyEvent("Enter");
    handler(e);

    expect(toggleExpandMock).toHaveBeenCalledTimes(1);
    expect(toggleExpandMock).toHaveBeenCalledWith("ws-1", "/proj/src");
    expect(openOrRevealEditorMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario D — useGroupActions.splitRight/splitDown → service newSplit state
// ---------------------------------------------------------------------------

function makeSplitActions(leafId: string, contextTabId: string) {
  // biome-ignore lint/correctness/useHookAtTopLevel: useGroupActions is a plain factory despite the "use" prefix; no React hooks inside
  return useGroupActions({
    workspaceId: WS,
    leafId,
    workspaceRootPath: "/workspace",
    getContextTabId: () => contextTabId,
    getTabIds: () => [],
    onActivateGroup: (groupId) => useLayoutStore.getState().setActiveGroup(WS, groupId),
  });
}

describe("Scenario D1: useGroupActions.splitRight produces a second leaf, source tab unchanged", () => {
  beforeEach(resetStores);

  it("splitRight creates a new leaf and source leaf still holds original tab", () => {
    const tab = openTerminalTab(WS, "terminal", { cwd: "/workspace" });
    const leafId = getLayout().activeGroupId;

    makeSplitActions(leafId, tab.id).splitRight();

    const layout = getLayout();
    expect(layout.root.kind).toBe("split");

    // Source leaf still has the original tab
    const sourceLeaf = findLeaf(layout.root, leafId);
    expect(sourceLeaf?.tabIds).toContain(tab.id);
  });
});

describe("Scenario D2: useGroupActions.splitDown produces a vertical split", () => {
  beforeEach(resetStores);

  it("splitDown creates a vertical split node", () => {
    const tab = openTerminalTab(WS, "terminal", { cwd: "/ws" });
    const leafId = getLayout().activeGroupId;

    makeSplitActions(leafId, tab.id).splitDown();

    const root = getLayout().root;
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      expect(root.orientation).toBe("vertical");
    }
  });
});

describe("Scenario D3: useGroupActions.splitRight — two tab records in tabsStore", () => {
  beforeEach(resetStores);

  it("tabsStore contains exactly 2 records with different ids after splitRight", () => {
    const tab = openOrRevealEditor({ workspaceId: WS, filePath: "/file.ts" });
    const leafId = getLayout().activeGroupId;

    makeSplitActions(leafId, tab.tabId).splitRight();

    const wsRecord = must(useTabsStore.getState().byWorkspace[WS], "workspace tabs");
    const ids = Object.keys(wsRecord);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);

    // Both records should be of type "editor"
    for (const id of ids) {
      expect(wsRecord[id]?.type).toBe("editor");
    }
  });
});

describe("Scenario D4: useGroupActions.splitRight with empty contextTabId is a no-op", () => {
  beforeEach(resetStores);

  it("no split occurs when contextTabId is empty string — guard branch in useGroupActions", () => {
    openTerminalTab(WS, "terminal", { cwd: "/ws" });

    makeSplitActions(getLayout().activeGroupId, "").splitRight();

    // Root should remain a sole leaf (no split)
    expect(getLayout().root.kind).toBe("leaf");
    expect(allLeaves(getLayout().root).length).toBe(1);
  });
});
