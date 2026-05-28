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

describe("createFileTreeKeydownHandler — Cmd+A selects all visible", () => {
  it("Cmd+A fills selection.paths with all flat paths", () => {
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
    for (const p of PATHS) {
      expect(selectIsSelected(s, WS, p)).toBe(true);
    }
    // Focus moves to last item (selectAll behaviour).
    expect(selectFocus(s, WS)).toBe(PATHS[PATHS.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// Escape — clearToFocus
// ---------------------------------------------------------------------------

describe("createFileTreeKeydownHandler — Escape clears to focus", () => {
  it("Escape after Cmd+A clears paths but keeps focus", () => {
    useFilesStore.getState().selectAllVisible(WS, PATHS);
    const lastFocus = selectFocus(useFilesStore.getState(), WS);

    const handler = createFileTreeKeydownHandler({
      flat,
      flatPaths,
      tree: undefined,
      workspaceId: WS,
      rootAbsPath: ROOT,
      activeIndex: flat.length - 1,
      setActiveIndex: () => {},
      scrollToIndex: () => {},
    });

    handler(makeKeyEvent("Escape"));

    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe(lastFocus);
    for (const p of PATHS) {
      expect(selectIsSelected(s, WS, p)).toBe(false);
    }
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
