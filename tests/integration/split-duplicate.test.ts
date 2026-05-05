/**
 * Integration: split-duplicate end-to-end verification
 *
 * SCOPE
 * -----
 * Scenario B — openTabInNewSplit on empty layout (ensureLayout auto-call)
 *   B1. Works when no prior openTab was called (ensureLayout triggered internally)
 *   B2. Layout slice exists and root becomes kind:split after the call
 *   B3. tabsStore gains exactly one new tab record
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
 *   - openTabInNewSplit on an empty workspace (ensureLayout path)
 *   - handleKeyDown logic extracted as inline handler mirrors (no DOM/React)
 *   - useGroupActions service-dispatch contract mirrored without React lifecycle
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

import { openOrRevealEditor } from "../../src/renderer/services/editor";
import { openTerminal } from "../../src/renderer/services/terminal";
import { openTab, openTabInNewSplit } from "../../src/renderer/state/operations";
import { useLayoutStore } from "../../src/renderer/state/stores/layout";
import { allLeaves, findLeaf } from "../../src/renderer/state/stores/layout/helpers";
import {
  type EditorTabProps,
  type TerminalTabProps,
  useTabsStore,
} from "../../src/renderer/state/stores/tabs";

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
// Scenario B — openTabInNewSplit on empty layout (ensureLayout auto-call)
// ---------------------------------------------------------------------------

describe("Scenario B1: openTabInNewSplit works on a fresh workspace with no prior layout", () => {
  beforeEach(resetStores);

  it("ensureLayout is triggered — byWorkspace entry is created", () => {
    expect(useLayoutStore.getState().byWorkspace[WS]).toBeUndefined();

    const result = openTabInNewSplit(
      WS,
      { type: "terminal", props: { cwd: "/new" } },
      "horizontal",
      "after",
    );

    expect(useLayoutStore.getState().byWorkspace[WS]).toBeDefined();
    expect(result.newLeafId).toBeTruthy();
    expect(result.tabId).toBeTruthy();
  });
});

describe("Scenario B2: openTabInNewSplit on empty layout produces kind:split root", () => {
  beforeEach(resetStores);

  it("root kind is split after openTabInNewSplit on empty workspace", () => {
    openTabInNewSplit(WS, { type: "terminal", props: { cwd: "/initial" } }, "horizontal", "after");
    expect(getLayout().root.kind).toBe("split");
  });
});

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
  opts: {
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    target?: unknown;
  } = {},
): MockKeyEvent {
  let prevented = false;
  return {
    key,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    target: opts.target ?? null,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

/**
 * Mirrors the plain-Enter / Space branches of FileTree.tsx for routing
 * verification. Cmd+Enter (open-to-side) used to live here too; that
 * keystroke is now driven by the global dispatcher's `openToSide`
 * binding (`when: "fileTreeFocus"`) and is covered by
 * `tests/unit/renderer/keybindings/dispatcher.test.ts`.
 */
function handleFileTreeKey(
  item: MockFlatItem,
  e: MockKeyEvent,
  deps: {
    openOrRevealEditor: (input: { workspaceId: string; filePath: string }) => void;
    toggleExpand: (wsId: string, absPath: string) => void;
  },
  workspaceId: string,
) {
  const isDir = item.node.type === "dir";

  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (isDir) {
      deps.toggleExpand(workspaceId, item.absPath);
    } else {
      deps.openOrRevealEditor({ workspaceId, filePath: item.absPath });
    }
  }
}

describe("Scenario C3: FileTree plain Enter on a file calls openOrRevealEditor", () => {
  it("routes to openOrRevealEditor for a file on plain Enter", () => {
    const openOrRevealEditorMock = mock(() => {});
    const fileItem: MockFlatItem = { absPath: "/proj/README.md", node: { type: "file" } };
    const e = makeMockKeyEvent("Enter", { metaKey: false });

    handleFileTreeKey(
      fileItem,
      e,
      {
        openOrRevealEditor: openOrRevealEditorMock,
        toggleExpand: mock(() => {}),
      },
      "ws-1",
    );

    expect(openOrRevealEditorMock).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("Scenario C4: FileTree plain Enter on a dir calls toggleExpand, not openOrRevealEditor", () => {
  it("routes to toggleExpand for a directory on plain Enter", () => {
    const openOrRevealEditorMock = mock(() => {});
    const toggleExpandMock = mock(() => {});
    const dirItem: MockFlatItem = { absPath: "/proj/src", node: { type: "dir" } };
    const e = makeMockKeyEvent("Enter", { metaKey: false });

    handleFileTreeKey(
      dirItem,
      e,
      {
        openOrRevealEditor: openOrRevealEditorMock,
        toggleExpand: toggleExpandMock,
      },
      "ws-1",
    );

    expect(toggleExpandMock).toHaveBeenCalledTimes(1);
    expect(openOrRevealEditorMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario D — splitRight/splitDown contract: simulate useGroupActions behavior
//
// Rather than importing the hook into a non-React test, we mirror its service
// dispatch: editor tabs route to openOrRevealEditor({ newSplit }) and terminal
// tabs route to openTerminal({ newSplit, groupId: leafId }).
// ---------------------------------------------------------------------------

/** Mirror of useGroupActions.splitRight/splitDown for test purposes */
function makeSplitActions(workspaceId: string, leafId: string, getContextTabId: () => string) {
  function split(orientation: "horizontal" | "vertical") {
    const tabId = getContextTabId();
    if (!tabId) return;
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (!tab) return;

    if (tab.type === "editor") {
      useLayoutStore.getState().setActiveGroup(workspaceId, leafId);
      openOrRevealEditor(tab.props as EditorTabProps, {
        newSplit: { orientation, side: "after" },
      });
      return;
    }

    if (tab.type === "terminal") {
      const props = tab.props as TerminalTabProps;
      openTerminal(
        { workspaceId, cwd: props.cwd },
        { groupId: leafId, newSplit: { orientation, side: "after" } },
      );
    }
  }

  return {
    splitRight() {
      split("horizontal");
    },
    splitDown() {
      split("vertical");
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
    const tab = openOrRevealEditor({ workspaceId: WS, filePath: "/file.ts" });
    const leafId = getLayout().activeGroupId;

    const actions = makeSplitActions(WS, leafId, () => tab.tabId);
    actions.splitRight();

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
