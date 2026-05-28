/**
 * Multi-select keyboard handler tests — Phase B.
 *
 * Covers the new Cmd+A, Escape, F2 (single/multi) branches inside
 * createFileTreeKeydownHandler.  Arrow and Enter/Space are already
 * tested by the existing file-tree-keys.test.ts; only the new paths
 * added in Phase B live here.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Shims — must run before store imports
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => () => {},
    off: () => {},
  },
};

// navigator.platform shim for isMac detection
Object.defineProperty(globalThis, "navigator", {
  value: { platform: "MacIntel" }, // force isMac = true
  writable: true,
});

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: () => Promise.resolve({ ok: true as const, value: [] }),
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

// ---------------------------------------------------------------------------
// Imports (after shims)
// ---------------------------------------------------------------------------

import { createFileTreeKeydownHandler } from "../../../../../src/renderer/components/files/keys";
import type { FlatItem } from "../../../../../src/renderer/state/stores/files";
import {
  selectFocus,
  selectIsSelected,
  useFilesStore,
} from "../../../../../src/renderer/state/stores/files";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "ws-kb-test";
const ROOT = "/repo";

function makeItem(absPath: string, type: "file" | "dir" = "file", depth = 0): FlatItem {
  const name = absPath.split("/").filter(Boolean).pop() ?? absPath;
  return {
    absPath,
    depth,
    node: { absPath, name, type, childrenLoaded: false, children: [] },
  };
}

const PATHS = ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts", "/repo/d.ts"];
const flat: FlatItem[] = PATHS.map((p) => makeItem(p, "file", 1));
const flatPaths = PATHS;

function makeKeyEvent(
  key: string,
  opts: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
): React.KeyboardEvent<HTMLDivElement> {
  const nativeEvent = {
    key,
    code: key,
    target: {
      tagName: "DIV",
      isContentEditable: false,
      closest: (sel: string) => (sel === '[role="tree"]' ? {} : null),
    },
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: false,
  } as unknown as KeyboardEvent;
  return {
    key,
    nativeEvent,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: false,
    preventDefault: () => {},
  } as unknown as React.KeyboardEvent<HTMLDivElement>;
}

function resetStore() {
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
  useFilesStore.getState().setSingleSelection(WS, PATHS[0]);
}

beforeEach(resetStore);

// ---------------------------------------------------------------------------
// Cmd+A — selectAllVisible
// ---------------------------------------------------------------------------

describe("createFileTreeKeydownHandler — Cmd+A hierarchical select-all", () => {
  it("Cmd+A from a flat-root-level row fills paths with that scope's descendants", () => {
    const handler = createFileTreeKeydownHandler({
      flat,
      flatPaths,
      tree: undefined,
      workspaceId: WS,
      rootAbsPath: ROOT,
      activeIndex: 0,
      setActiveIndex: () => {},
      scrollToIndex: () => {},
    });

    handler(makeKeyEvent("a", { metaKey: true }));

    const s = useFilesStore.getState();
    // With every path's immediate parent being ROOT, the first press already
    // expands to the workspace root scope — which contains every flat row.
    for (const p of PATHS) {
      expect(selectIsSelected(s, WS, p)).toBe(true);
    }
    // Focus stays put (hierarchical select-all does not relocate the cursor).
    expect(selectFocus(s, WS)).toBe(PATHS[0]);
  });
});

// ---------------------------------------------------------------------------
// Escape — two-step deselect (range/multi → single → empty)
// ---------------------------------------------------------------------------

describe("createFileTreeKeydownHandler — Escape two-step deselect", () => {
  function buildHandler() {
    return createFileTreeKeydownHandler({
      flat,
      flatPaths,
      tree: undefined,
      workspaceId: WS,
      rootAbsPath: ROOT,
      activeIndex: flat.length - 1,
      setActiveIndex: () => {},
      scrollToIndex: () => {},
    });
  }

  it("first Escape after Cmd+A narrows multi-select to the focused row", () => {
    useFilesStore.getState().selectAllVisible(WS, PATHS);
    const lastFocus = selectFocus(useFilesStore.getState(), WS);

    buildHandler()(makeKeyEvent("Escape"));

    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe(lastFocus);
    for (const p of PATHS) {
      expect(selectIsSelected(s, WS, p)).toBe(p === lastFocus);
    }
  });

  it("Escape on canonical single selection fully clears (focus=null, paths empty)", () => {
    // beforeEach already established a single selection on PATHS[0].
    expect(selectFocus(useFilesStore.getState(), WS)).toBe(PATHS[0]);

    buildHandler()(makeKeyEvent("Escape"));

    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBeNull();
    for (const p of PATHS) {
      expect(selectIsSelected(s, WS, p)).toBe(false);
    }
  });

  it("two presses from a Cmd+A state reach the empty state", () => {
    useFilesStore.getState().selectAllVisible(WS, PATHS);

    const handler = buildHandler();
    handler(makeKeyEvent("Escape")); // narrow
    handler(makeKeyEvent("Escape")); // clear

    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBeNull();
    for (const p of PATHS) {
      expect(selectIsSelected(s, WS, p)).toBe(false);
    }
  });

  it("Escape on already-empty selection is a safe no-op", () => {
    useFilesStore.setState({ trees: new Map(), selection: new Map() });

    buildHandler()(makeKeyEvent("Escape"));

    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F2 — single selection → startRename called
// ---------------------------------------------------------------------------

describe("createFileTreeKeydownHandler — F2 single selection", () => {
  it("F2 with single focus calls startRename", () => {
    const startRename = mock((_path: string) => {});
    useFilesStore.getState().setSingleSelection(WS, PATHS[1]);

    const handler = createFileTreeKeydownHandler({
      flat,
      flatPaths,
      tree: undefined,
      workspaceId: WS,
      rootAbsPath: ROOT,
      activeIndex: 1,
      setActiveIndex: () => {},
      scrollToIndex: () => {},
      startRename,
    });

    handler(makeKeyEvent("F2"));

    expect(startRename).toHaveBeenCalledWith(PATHS[1]);
  });
});

// ---------------------------------------------------------------------------
// F2 — multi-selection → toast shown, startRename NOT called
// ---------------------------------------------------------------------------

describe("createFileTreeKeydownHandler — F2 multi-selection", () => {
  it("F2 with multiple paths in selection does not call startRename", () => {
    const startRename = mock((_path: string) => {});
    // Select multiple rows.
    useFilesStore.getState().selectAllVisible(WS, PATHS);

    const handler = createFileTreeKeydownHandler({
      flat,
      flatPaths,
      tree: undefined,
      workspaceId: WS,
      rootAbsPath: ROOT,
      activeIndex: 0,
      setActiveIndex: () => {},
      scrollToIndex: () => {},
      startRename,
    });

    handler(makeKeyEvent("F2"));

    expect(startRename).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F2 — root path → no rename
// ---------------------------------------------------------------------------

describe("createFileTreeKeydownHandler — F2 root path no-op", () => {
  it("F2 on the workspace root does not call startRename", () => {
    const startRename = mock((_path: string) => {});
    const rootItem = makeItem(ROOT, "dir", 0);

    const handler = createFileTreeKeydownHandler({
      flat: [rootItem],
      flatPaths: [ROOT],
      tree: undefined,
      workspaceId: WS,
      rootAbsPath: ROOT,
      activeIndex: 0,
      setActiveIndex: () => {},
      scrollToIndex: () => {},
      startRename,
    });

    handler(makeKeyEvent("F2"));

    expect(startRename).not.toHaveBeenCalled();
  });
});
