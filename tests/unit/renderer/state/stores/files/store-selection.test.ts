/**
 * Store selection reducer tests.
 *
 * Covers the 7 selection actions:
 *   setSingleSelection, toggleSelection, extendSelectionTo,
 *   selectAllVisible, clearToFocus, setFocus, clearSelection.
 *
 * Also covers closeAllForWorkspace cleaning up the selection Map.
 */

import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Shims (must come before store import)
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  selectFocus,
  selectIsFocused,
  selectIsSelected,
  useFilesStore,
} from "../../../../../../src/renderer/state/stores/files";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "ws-sel-test";

function resetStore() {
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
}

const flatPaths = ["/r/a", "/r/b", "/r/c", "/r/d", "/r/e"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(resetStore);

// ---------------------------------------------------------------------------
// setSingleSelection
// ---------------------------------------------------------------------------

describe("setSingleSelection", () => {
  it("sets focus and clears paths", () => {
    useFilesStore.getState().setSingleSelection(WS, "/r/b");
    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe("/r/b");
    expect(selectIsFocused(s, WS, "/r/b")).toBe(true);
    expect(selectIsSelected(s, WS, "/r/b")).toBe(false); // paths is empty
  });

  it("replaces a prior selection", () => {
    useFilesStore.getState().setSingleSelection(WS, "/r/a");
    useFilesStore.getState().setSingleSelection(WS, "/r/c");
    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe("/r/c");
    expect(selectIsFocused(s, WS, "/r/a")).toBe(false);
  });

  it("is idempotent (no-op when already single-selected)", () => {
    useFilesStore.getState().setSingleSelection(WS, "/r/b");
    const mapRef1 = useFilesStore.getState().selection;
    useFilesStore.getState().setSingleSelection(WS, "/r/b");
    const mapRef2 = useFilesStore.getState().selection;
    // Same reference returned — no mutation.
    expect(mapRef1).toBe(mapRef2);
  });
});

// ---------------------------------------------------------------------------
// toggleSelection
// ---------------------------------------------------------------------------

describe("toggleSelection", () => {
  it("adds path to paths set on first toggle", () => {
    useFilesStore.getState().setSingleSelection(WS, "/r/a");
    useFilesStore.getState().toggleSelection(WS, "/r/b");
    const s = useFilesStore.getState();
    expect(selectIsSelected(s, WS, "/r/b")).toBe(true);
    expect(selectFocus(s, WS)).toBe("/r/b");
  });

  it("removes path from paths set on second toggle", () => {
    useFilesStore.getState().setSingleSelection(WS, "/r/a");
    useFilesStore.getState().toggleSelection(WS, "/r/b");
    useFilesStore.getState().toggleSelection(WS, "/r/b");
    const s = useFilesStore.getState();
    expect(selectIsSelected(s, WS, "/r/b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extendSelectionTo
// ---------------------------------------------------------------------------

describe("extendSelectionTo", () => {
  it("selects a contiguous range from anchor to target", () => {
    useFilesStore.getState().setSingleSelection(WS, "/r/b"); // anchor = b
    useFilesStore.getState().extendSelectionTo(WS, "/r/d", flatPaths);
    const s = useFilesStore.getState();
    expect(selectIsSelected(s, WS, "/r/b")).toBe(true);
    expect(selectIsSelected(s, WS, "/r/c")).toBe(true);
    expect(selectIsSelected(s, WS, "/r/d")).toBe(true);
    expect(selectIsSelected(s, WS, "/r/a")).toBe(false);
    expect(selectFocus(s, WS)).toBe("/r/d");
  });
});

// ---------------------------------------------------------------------------
// selectAllVisible
// ---------------------------------------------------------------------------

describe("selectAllVisible", () => {
  it("selects all paths and moves focus to the last", () => {
    useFilesStore.getState().selectAllVisible(WS, flatPaths);
    const s = useFilesStore.getState();
    for (const p of flatPaths) {
      expect(selectIsSelected(s, WS, p)).toBe(true);
    }
    expect(selectFocus(s, WS)).toBe("/r/e");
  });
});

// ---------------------------------------------------------------------------
// clearToFocus
// ---------------------------------------------------------------------------

describe("clearToFocus", () => {
  it("keeps focus but wipes paths and resets anchor to focus", () => {
    useFilesStore.getState().selectAllVisible(WS, flatPaths);
    useFilesStore.getState().clearToFocus(WS);
    const s = useFilesStore.getState();
    // Focus stays at the last item selected by selectAll
    expect(selectFocus(s, WS)).toBe("/r/e");
    // paths cleared
    for (const p of flatPaths) {
      expect(selectIsSelected(s, WS, p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// setFocus
// ---------------------------------------------------------------------------

describe("setFocus", () => {
  it("moves focus without touching paths", () => {
    // Setup: b and c selected
    useFilesStore.getState().setSingleSelection(WS, "/r/b");
    useFilesStore.getState().extendSelectionTo(WS, "/r/c", flatPaths);
    useFilesStore.getState().setFocus(WS, "/r/a");
    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe("/r/a");
    // Paths still contain b and c
    expect(selectIsSelected(s, WS, "/r/b")).toBe(true);
    expect(selectIsSelected(s, WS, "/r/c")).toBe(true);
  });

  it("is a no-op when focus is already at the given path", () => {
    useFilesStore.getState().setSingleSelection(WS, "/r/a");
    const ref1 = useFilesStore.getState().selection;
    useFilesStore.getState().setFocus(WS, "/r/a");
    const ref2 = useFilesStore.getState().selection;
    expect(ref1).toBe(ref2);
  });
});

// ---------------------------------------------------------------------------
// clearSelection
// ---------------------------------------------------------------------------

describe("clearSelection", () => {
  it("resets selection to empty (focus=null, paths={}, anchor=null)", () => {
    useFilesStore.getState().selectAllVisible(WS, flatPaths);
    useFilesStore.getState().clearSelection(WS);
    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBeNull();
    for (const p of flatPaths) {
      expect(selectIsSelected(s, WS, p)).toBe(false);
    }
  });

  it("is a no-op when selection for workspace does not exist", () => {
    const ref1 = useFilesStore.getState().selection;
    useFilesStore.getState().clearSelection("nonexistent-ws");
    const ref2 = useFilesStore.getState().selection;
    expect(ref1).toBe(ref2);
  });
});

// ---------------------------------------------------------------------------
// closeAllForWorkspace — selection cleanup
// ---------------------------------------------------------------------------

describe("closeAllForWorkspace cleans up selection", () => {
  it("removes the selection entry for the removed workspace", () => {
    useFilesStore.getState().setSingleSelection(WS, "/r/a");
    useFilesStore.getState().closeAllForWorkspace(WS);
    const s = useFilesStore.getState();
    expect(s.selection.has(WS)).toBe(false);
    expect(selectFocus(s, WS)).toBeNull();
  });
});
