/**
 * Phase B — handleRowClick gesture routing tests.
 *
 * These tests exercise the 4-gesture split added in Phase B:
 *   - plain click   → setSingleSelection + primary action (open/toggleExpand)
 *   - Cmd/Ctrl click → toggleSelection (no file open)
 *   - Shift click   → extendSelectionTo (no file open)
 *
 * The tests verify only the store-side effect (selection state), not the
 * side-effects of openOrRevealEditor / toggleExpand (those are mocked out).
 */

import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Shims
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Imports (after shims)
// ---------------------------------------------------------------------------

import {
  selectFocus,
  selectIsSelected,
  useFilesStore,
} from "../../../../../src/renderer/state/stores/files";

// ---------------------------------------------------------------------------
// Inline simulation of handleRowClick logic (extracted from index.tsx).
// The full component can't be mounted without Electron / jsdom; instead we
// replicate only the store-routing logic under test, which is a pure
// function of (store + input).
// ---------------------------------------------------------------------------

const WS = "ws-click-test";
const PATHS = ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts", "/repo/d.ts"];

function makeMouseEvent(
  opts: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
): React.MouseEvent {
  return {
    shiftKey: opts.shiftKey ?? false,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
  } as unknown as React.MouseEvent;
}

type NodeType = "file" | "dir";

function handleRowClick(
  absPath: string,
  _nodeType: NodeType,
  e: React.MouseEvent,
  flatPaths: readonly string[],
) {
  const store = useFilesStore.getState();

  if (e.shiftKey) {
    store.extendSelectionTo(WS, absPath, flatPaths);
    return;
  }

  if (e.metaKey || e.ctrlKey) {
    store.toggleSelection(WS, absPath);
    return;
  }

  store.setSingleSelection(WS, absPath);
  // Primary action (openOrRevealEditor / toggleExpand) not tested here —
  // this suite verifies selection store routing only.
}

function resetStore() {
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
}

beforeEach(resetStore);

// ---------------------------------------------------------------------------
// Plain click
// ---------------------------------------------------------------------------

describe("handleRowClick — plain click", () => {
  it("plain click on file → single-selects", () => {
    handleRowClick(PATHS[1], "file", makeMouseEvent(), PATHS);
    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe(PATHS[1]);
    expect(selectIsSelected(s, WS, PATHS[1])).toBe(false); // paths is empty on single
    expect(selectIsSelected(s, WS, PATHS[0])).toBe(false);
  });

  it("plain click on dir → single-selects (toggleExpand is the action, not tested here)", () => {
    handleRowClick(PATHS[0], "dir", makeMouseEvent(), PATHS);
    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe(PATHS[0]);
  });
});

// ---------------------------------------------------------------------------
// Cmd/Ctrl click — toggle
// ---------------------------------------------------------------------------

describe("handleRowClick — Cmd/Ctrl click toggles selection", () => {
  it("Cmd-click first path adds it to paths set", () => {
    useFilesStore.getState().setSingleSelection(WS, PATHS[0]);
    handleRowClick(PATHS[1], "file", makeMouseEvent({ metaKey: true }), PATHS);
    const s = useFilesStore.getState();
    expect(selectIsSelected(s, WS, PATHS[1])).toBe(true);
    expect(selectFocus(s, WS)).toBe(PATHS[1]);
  });

  it("Cmd-click same path removes it from paths set", () => {
    useFilesStore.getState().setSingleSelection(WS, PATHS[0]);
    handleRowClick(PATHS[1], "file", makeMouseEvent({ metaKey: true }), PATHS);
    // Second click removes it.
    handleRowClick(PATHS[1], "file", makeMouseEvent({ metaKey: true }), PATHS);
    const s = useFilesStore.getState();
    expect(selectIsSelected(s, WS, PATHS[1])).toBe(false);
  });

  it("Ctrl-click also toggles (non-Mac modifier)", () => {
    useFilesStore.getState().setSingleSelection(WS, PATHS[0]);
    handleRowClick(PATHS[2], "file", makeMouseEvent({ ctrlKey: true }), PATHS);
    const s = useFilesStore.getState();
    expect(selectIsSelected(s, WS, PATHS[2])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shift click — extend range
// ---------------------------------------------------------------------------

describe("handleRowClick — Shift click extends range", () => {
  it("Shift-click extends from anchor to target", () => {
    // Anchor: click PATHS[0] first (single select → anchor=PATHS[0]).
    handleRowClick(PATHS[0], "file", makeMouseEvent(), PATHS);
    // Shift-click PATHS[2] → range [0..2].
    handleRowClick(PATHS[2], "file", makeMouseEvent({ shiftKey: true }), PATHS);
    const s = useFilesStore.getState();
    expect(selectIsSelected(s, WS, PATHS[0])).toBe(true);
    expect(selectIsSelected(s, WS, PATHS[1])).toBe(true);
    expect(selectIsSelected(s, WS, PATHS[2])).toBe(true);
    expect(selectIsSelected(s, WS, PATHS[3])).toBe(false);
    expect(selectFocus(s, WS)).toBe(PATHS[2]);
  });

  it("Shift-click in reverse direction selects correct range", () => {
    handleRowClick(PATHS[3], "file", makeMouseEvent(), PATHS);
    handleRowClick(PATHS[1], "file", makeMouseEvent({ shiftKey: true }), PATHS);
    const s = useFilesStore.getState();
    expect(selectIsSelected(s, WS, PATHS[1])).toBe(true);
    expect(selectIsSelected(s, WS, PATHS[2])).toBe(true);
    expect(selectIsSelected(s, WS, PATHS[3])).toBe(true);
    expect(selectIsSelected(s, WS, PATHS[0])).toBe(false);
  });
});
