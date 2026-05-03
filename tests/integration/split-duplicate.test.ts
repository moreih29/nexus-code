/**
 * Integration: split-duplicate end-to-end verification
 *
 * agent_id: tester
 *
 * SCOPE
 * -----
 * Scenario A — splitAndDuplicate: additional coverage beyond operations.test.ts
 *   A1. Both source and destination tabs have distinct ids in tabsStore
 *   A2. After duplication, root becomes kind:split (two leaves)
 *   A3. Horizontal split places new leaf as second child
 *   A4. Vertical split creates a vertical split node
 *   A5. Destination leaf becomes the active group after split
 *
 * Scenario B — openTabInNewSplit on empty layout (ensureLayout auto-call)
 *   B1. Works when no prior openTab was called (ensureLayout triggered internally)
 *   B2. Layout slice exists and root becomes kind:split after the call
 *   B3. tabsStore gains exactly one new tab record
 *
 * Scenario C — FileTree handleKeyDown branching (dir vs file) — pure function test
 *   C1. File node + Cmd+Enter routes to openTabInNewSplit (not openTab)
 *   C2. Dir node + Cmd+Enter is a no-op (neither open function called)
 *   C3. File node + Enter routes to openTab (not openTabInNewSplit)
 *   C4. Dir node + Enter calls toggleExpand, not openTab
 *
 * Scenario D — useGroupActions.splitRight/splitDown → splitAndDuplicate store state
 *   D1. splitRight produces a second leaf, source tab unchanged
 *   D2. splitDown produces a vertical split leaf
 *   D3. Two tab records exist in tabsStore after splitRight
 *   D4. Empty contextTabId is a no-op (guard branch)
 *
 * AUTOMATION BOUNDARIES
 * ---------------------
 * What IS automated:
 *   - Store-level state changes for split + duplicate operations
 *   - openTabInNewSplit on an empty workspace (ensureLayout path)
 *   - handleKeyDown logic extracted as inline handler mirrors (no DOM/React)
 *   - useGroupActions wired directly to store (no React component lifecycle)
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
// Mock ipcCall
// ---------------------------------------------------------------------------

mock.module("../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import { useLayoutStore } from "../../src/renderer/store/layout";
import {
  openTab,
  openTabInNewSplit,
  splitAndDuplicate,
} from "../../src/renderer/store/operations";
import { useTabsStore } from "../../src/renderer/store/tabs";
import { allLeaves, findLeaf } from "../../src/renderer/store/layout/helpers";

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
  if (!layout) throw new Error("layout slice not found for " + WS);
  return layout;
}

// ---------------------------------------------------------------------------
// Scenario A — splitAndDuplicate: additional coverage
// ---------------------------------------------------------------------------

describe("Scenario A1: source and destination tabs have distinct ids in tabsStore", () => {
  beforeEach(resetStores);

  it("tabsStore has exactly 2 records with different ids after splitAndDuplicate", () => {
    const tab = openTab(WS, "terminal", { cwd: "/root" });
    const sourceLeafId = getLayout().activeGroupId;

    const result = splitAndDuplicate(WS, sourceLeafId, tab.id, "horizontal", "after");
    expect(result).not.toBeNull();

    const wsRecord = useTabsStore.getState().byWorkspace[WS]!;
    const ids = Object.keys(wsRecord);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
    // Both ids referenced by layout leaves
    const leaves = allLeaves(getLayout().root);
    const allTabIds = leaves.flatMap((l) => l.tabIds);
    expect(allTabIds).toContain(tab.id);
    expect(allTabIds).toContain(result!.newTabId);
  });
});

describe("Scenario A2: root becomes kind:split after splitAndDuplicate", () => {
  beforeEach(resetStores);

  it("root node kind changes from leaf to split", () => {
    const tab = openTab(WS, "terminal", { cwd: "/src" });
    expect(getLayout().root.kind).toBe("leaf");

    splitAndDuplicate(WS, getLayout().activeGroupId, tab.id, "horizontal", "after");

    expect(getLayout().root.kind).toBe("split");
  });
});

describe("Scenario A3: horizontal split places new leaf as second child", () => {
  beforeEach(resetStores);

  it("source leaf is the first child; new leaf is the second child after side=after", () => {
    const tab = openTab(WS, "terminal", { cwd: "/a" });
    const sourceLeafId = getLayout().activeGroupId;

    const result = splitAndDuplicate(WS, sourceLeafId, tab.id, "horizontal", "after");

    const root = getLayout().root;
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      expect(root.orientation).toBe("horizontal");
      expect(root.first.id).toBe(sourceLeafId);
      expect(root.second.id).toBe(result!.newLeafId);
    }
  });
});

describe("Scenario A4: vertical split creates a vertical split node", () => {
  beforeEach(resetStores);

  it("split orientation is vertical when requested", () => {
    const tab = openTab(WS, "terminal", { cwd: "/b" });
    splitAndDuplicate(WS, getLayout().activeGroupId, tab.id, "vertical", "after");

    const root = getLayout().root;
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      expect(root.orientation).toBe("vertical");
    }
  });
});

describe("Scenario A5: destination leaf becomes active group after splitAndDuplicate", () => {
  beforeEach(resetStores);

  it("activeGroupId points to newLeafId after split", () => {
    const tab = openTab(WS, "terminal", { cwd: "/c" });
    const sourceLeafId = getLayout().activeGroupId;

    const result = splitAndDuplicate(WS, sourceLeafId, tab.id, "horizontal", "after");

    expect(getLayout().activeGroupId).toBe(result!.newLeafId);
  });
});

// ---------------------------------------------------------------------------
// Scenario B — openTabInNewSplit on empty layout (ensureLayout auto-call)
// ---------------------------------------------------------------------------

describe("Scenario B1: openTabInNewSplit works on a fresh workspace with no prior layout", () => {
  beforeEach(resetStores);

  it("ensureLayout is triggered — byWorkspace entry is created", () => {
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeUndefined();

    const result = openTabInNewSplit(WS, "terminal", { cwd: "/new" }, "horizontal", "after");

    expect(useLayoutStore.getState().byWorkspace[WS]).toBeDefined();
    expect(result.newLeafId).toBeTruthy();
    expect(result.tabId).toBeTruthy();
  });
});

describe("Scenario B2: openTabInNewSplit on empty layout produces kind:split root", () => {
  beforeEach(resetStores);

  it("root kind is split after openTabInNewSplit on empty workspace", () => {
    openTabInNewSplit(WS, "terminal", { cwd: "/initial" }, "horizontal", "after");
    expect(getLayout().root.kind).toBe("split");
  });
});

describe("Scenario B3: openTabInNewSplit on empty layout creates exactly one tab record", () => {
  beforeEach(resetStores);

  it("tabsStore gains exactly one tab on empty workspace", () => {
    const result = openTabInNewSplit(WS, "editor", { filePath: "/index.ts", workspaceId: WS }, "horizontal", "after");

    const wsRecord = useTabsStore.getState().byWorkspace[WS];
    expect(wsRecord).toBeDefined();
    expect(Object.keys(wsRecord!).length).toBe(1);
    expect(wsRecord![result.tabId]).toBeDefined();
    expect(wsRecord![result.tabId]?.type).toBe("editor");
  });
});

// ---------------------------------------------------------------------------
// Scenario C — FileTree handleKeyDown branching (dir vs file) — pure logic test
//
// The handleKeyDown function in FileTree.tsx is a React event handler bound to
// local state (flat, activeIndex, etc.), so we cannot import it directly.
// Instead we extract the exact branching logic as a testable pure function that
// mirrors the code in handleKeyDown. This verifies the branch semantics without
// needing DOM / React, consistent with the established project pattern for
// keybinding tests (keybindings-global.test.ts).
// ---------------------------------------------------------------------------

interface MockFlatItem {
  absPath: string;
  node: { type: "file" | "dir" };
}

interface MockKeyEvent {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

function makeMockKeyEvent(
  key: string,
  opts: { metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; target?: unknown } = {},
): MockKeyEvent {
  let prevented = false;
  return {
    key,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    target: opts.target ?? null,
    get defaultPrevented() { return prevented; },
    preventDefault() { prevented = true; },
  };
}

/**
 * Mirrors the handleKeyDown logic from FileTree.tsx for branch testing.
 * Kept in sync with the component's Enter / Cmd+Enter branches.
 */
function handleFileTreeKey(
  item: MockFlatItem,
  e: MockKeyEvent,
  deps: {
    openTab: (wsId: string, type: string, props: object) => void;
    openTabInNewSplit: (wsId: string, type: string, props: object, orientation: string, side: string) => void;
    toggleExpand: (wsId: string, absPath: string) => void;
    isInEditable: (target: unknown) => boolean;
  },
  workspaceId: string,
) {
  const isDir = item.node.type === "dir";

  if (e.key === "Enter" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
    if (deps.isInEditable(e.target)) return;
    if (isDir) return;
    e.preventDefault();
    deps.openTabInNewSplit(workspaceId, "editor", { filePath: item.absPath, workspaceId }, "horizontal", "after");
    return;
  }

  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (isDir) {
      deps.toggleExpand(workspaceId, item.absPath);
    } else {
      deps.openTab(workspaceId, "editor", { filePath: item.absPath, workspaceId });
    }
  }
}

describe("Scenario C1: FileTree Cmd+Enter on a file calls openTabInNewSplit", () => {
  it("routes to openTabInNewSplit and NOT openTab", () => {
    const openTabMock = mock(() => {});
    const openTabInNewSplitMock = mock(() => {});
    const toggleExpandMock = mock(() => {});
    const fileItem: MockFlatItem = { absPath: "/proj/src/index.ts", node: { type: "file" } };
    const e = makeMockKeyEvent("Enter", { metaKey: true });

    handleFileTreeKey(fileItem, e, {
      openTab: openTabMock,
      openTabInNewSplit: openTabInNewSplitMock,
      toggleExpand: toggleExpandMock,
      isInEditable: () => false,
    }, "ws-test");

    expect(openTabInNewSplitMock).toHaveBeenCalledTimes(1);
    expect(openTabMock).not.toHaveBeenCalled();
    expect(toggleExpandMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("passes correct filePath and orientation to openTabInNewSplit", () => {
    const openTabInNewSplitMock = mock(
      (_wsId: string, _type: string, _props: object, _orientation: string, _side: string) => {}
    );
    const fileItem: MockFlatItem = { absPath: "/app/main.ts", node: { type: "file" } };
    const e = makeMockKeyEvent("Enter", { metaKey: true });

    handleFileTreeKey(fileItem, e, {
      openTab: mock(() => {}),
      openTabInNewSplit: openTabInNewSplitMock,
      toggleExpand: mock(() => {}),
      isInEditable: () => false,
    }, "ws-1");

    const call = openTabInNewSplitMock.mock.calls[0];
    expect(call[2]).toMatchObject({ filePath: "/app/main.ts" });
    expect(call[3]).toBe("horizontal");
    expect(call[4]).toBe("after");
  });
});

describe("Scenario C2: FileTree Cmd+Enter on a dir is a no-op", () => {
  it("neither openTab nor openTabInNewSplit is called for a directory", () => {
    const openTabMock = mock(() => {});
    const openTabInNewSplitMock = mock(() => {});
    const dirItem: MockFlatItem = { absPath: "/proj/src", node: { type: "dir" } };
    const e = makeMockKeyEvent("Enter", { metaKey: true });

    handleFileTreeKey(dirItem, e, {
      openTab: openTabMock,
      openTabInNewSplit: openTabInNewSplitMock,
      toggleExpand: mock(() => {}),
      isInEditable: () => false,
    }, "ws-test");

    expect(openTabInNewSplitMock).not.toHaveBeenCalled();
    expect(openTabMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("Scenario C3: FileTree plain Enter on a file calls openTab (not openTabInNewSplit)", () => {
  it("routes to openTab for a file on plain Enter", () => {
    const openTabMock = mock(() => {});
    const openTabInNewSplitMock = mock(() => {});
    const fileItem: MockFlatItem = { absPath: "/proj/README.md", node: { type: "file" } };
    const e = makeMockKeyEvent("Enter", { metaKey: false });

    handleFileTreeKey(fileItem, e, {
      openTab: openTabMock,
      openTabInNewSplit: openTabInNewSplitMock,
      toggleExpand: mock(() => {}),
      isInEditable: () => false,
    }, "ws-1");

    expect(openTabMock).toHaveBeenCalledTimes(1);
    expect(openTabInNewSplitMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("Scenario C4: FileTree plain Enter on a dir calls toggleExpand, not openTab", () => {
  it("routes to toggleExpand for a directory on plain Enter", () => {
    const openTabMock = mock(() => {});
    const toggleExpandMock = mock(() => {});
    const dirItem: MockFlatItem = { absPath: "/proj/src", node: { type: "dir" } };
    const e = makeMockKeyEvent("Enter", { metaKey: false });

    handleFileTreeKey(dirItem, e, {
      openTab: openTabMock,
      openTabInNewSplit: mock(() => {}),
      toggleExpand: toggleExpandMock,
      isInEditable: () => false,
    }, "ws-1");

    expect(toggleExpandMock).toHaveBeenCalledTimes(1);
    expect(openTabMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario D — splitRight/splitDown contract: simulate useGroupActions behavior
//
// useGroupActions.ts uses "@/" path aliases which are not resolvable in the
// Bun test runner (no bunfig.toml / tsconfig.json with paths at the root).
// Rather than importing the hook directly, we verify the same store-level
// contract by reproducing the exact code path that useGroupActions.splitRight
// and splitDown execute:
//
//   function splitRight() {
//     const tabId = getContextTabId();
//     if (!tabId) return;
//     splitAndDuplicate(workspaceId, leafId, tabId, "horizontal", "after");
//   }
//
// This validates the integration between the context-menu action and the
// underlying split operation without requiring the @/ alias to resolve.
// ---------------------------------------------------------------------------

/** Mirror of useGroupActions.splitRight/splitDown for test purposes */
function makeSplitActions(
  workspaceId: string,
  leafId: string,
  getContextTabId: () => string,
) {
  return {
    splitRight() {
      const tabId = getContextTabId();
      if (!tabId) return;
      splitAndDuplicate(workspaceId, leafId, tabId, "horizontal", "after");
    },
    splitDown() {
      const tabId = getContextTabId();
      if (!tabId) return;
      splitAndDuplicate(workspaceId, leafId, tabId, "vertical", "after");
    },
  };
}

describe("Scenario D1: splitRight (useGroupActions mirror) produces a second leaf, source tab unchanged", () => {
  beforeEach(resetStores);

  it("splitRight creates a new leaf and source leaf still holds original tab", () => {
    const tab = openTab(WS, "terminal", { cwd: "/workspace" });
    const leafId = getLayout().activeGroupId;

    const actions = makeSplitActions(WS, leafId, () => tab.id);
    actions.splitRight();

    const layout = getLayout();
    expect(layout.root.kind).toBe("split");

    // Source leaf still has the original tab
    const sourceLeaf = findLeaf(layout.root, leafId);
    expect(sourceLeaf?.tabIds).toContain(tab.id);
  });
});

describe("Scenario D2: splitDown (useGroupActions mirror) produces a vertical split", () => {
  beforeEach(resetStores);

  it("splitDown creates a vertical split node", () => {
    const tab = openTab(WS, "terminal", { cwd: "/ws" });
    const leafId = getLayout().activeGroupId;

    const actions = makeSplitActions(WS, leafId, () => tab.id);
    actions.splitDown();

    const root = getLayout().root;
    expect(root.kind).toBe("split");
    if (root.kind === "split") {
      expect(root.orientation).toBe("vertical");
    }
  });
});

describe("Scenario D3: splitRight (useGroupActions mirror) — two tab records in tabsStore", () => {
  beforeEach(resetStores);

  it("tabsStore contains exactly 2 records with different ids after splitRight", () => {
    const tab = openTab(WS, "editor", { filePath: "/file.ts", workspaceId: WS });
    const leafId = getLayout().activeGroupId;

    const actions = makeSplitActions(WS, leafId, () => tab.id);
    actions.splitRight();

    const wsRecord = useTabsStore.getState().byWorkspace[WS]!;
    const ids = Object.keys(wsRecord);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);

    // Both records should be of type "editor"
    for (const id of ids) {
      expect(wsRecord[id]?.type).toBe("editor");
    }
  });
});

describe("Scenario D4: splitRight (useGroupActions mirror) with empty contextTabId is a no-op", () => {
  beforeEach(resetStores);

  it("no split occurs when contextTabId is empty string — guard branch in useGroupActions", () => {
    openTab(WS, "terminal", { cwd: "/ws" });

    // Guard: useGroupActions.splitRight does `if (!tabId) return`
    const actions = makeSplitActions(WS, getLayout().activeGroupId, () => "");
    actions.splitRight();

    // Root should remain a sole leaf (no split)
    expect(getLayout().root.kind).toBe("leaf");
    expect(allLeaves(getLayout().root).length).toBe(1);
  });
});
