/**
 * Pure helper tests for selection.ts.
 *
 * Each function is pure (no React, no Zustand) so these tests run in
 * plain Node/Bun with no shims required.
 */

import { describe, expect, it } from "bun:test";
import {
  emptySelection,
  extendSelection,
  getOperablePaths,
  isFocused,
  isSelected,
  selectAll,
  selectAllHierarchical,
  singleSelection,
  toggleInSelection,
} from "../../../../../../src/renderer/state/stores/files/selection";
import type { FileSelection } from "../../../../../../src/renderer/state/stores/files/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const flatPaths = ["/r/a", "/r/b", "/r/c", "/r/d", "/r/e"];

// ---------------------------------------------------------------------------
// isSelected
// ---------------------------------------------------------------------------

describe("isSelected", () => {
  it("returns true when path is in paths set", () => {
    const sel: FileSelection = {
      focus: "/r/a",
      anchor: "/r/a",
      paths: new Set(["/r/a", "/r/b"]),
    };
    expect(isSelected(sel, "/r/a")).toBe(true);
    expect(isSelected(sel, "/r/b")).toBe(true);
  });

  it("returns false when path is not in paths set", () => {
    const sel: FileSelection = { focus: "/r/a", anchor: "/r/a", paths: new Set(["/r/a"]) };
    expect(isSelected(sel, "/r/c")).toBe(false);
  });

  it("returns false for emptySelection", () => {
    expect(isSelected(emptySelection(), "/r/a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFocused
// ---------------------------------------------------------------------------

describe("isFocused", () => {
  it("returns true when path equals focus", () => {
    const sel: FileSelection = { focus: "/r/b", anchor: null, paths: new Set() };
    expect(isFocused(sel, "/r/b")).toBe(true);
  });

  it("returns false when path differs from focus", () => {
    const sel: FileSelection = { focus: "/r/b", anchor: null, paths: new Set() };
    expect(isFocused(sel, "/r/a")).toBe(false);
  });

  it("returns false when focus is null", () => {
    expect(isFocused(emptySelection(), "/r/a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getOperablePaths
// ---------------------------------------------------------------------------

describe("getOperablePaths", () => {
  it("returns [...paths] when paths is non-empty (paths takes precedence over focus)", () => {
    const sel: FileSelection = {
      focus: "/r/a",
      anchor: "/r/a",
      paths: new Set(["/r/b", "/r/c"]),
    };
    const result = getOperablePaths(sel);
    expect(result).toHaveLength(2);
    expect(result).toContain("/r/b");
    expect(result).toContain("/r/c");
  });

  it("returns [focus] when paths is empty and focus is set", () => {
    const sel = singleSelection("/r/d");
    expect(getOperablePaths(sel)).toEqual(["/r/d"]);
  });

  it("returns [] when paths is empty and focus is null", () => {
    expect(getOperablePaths(emptySelection())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// singleSelection
// ---------------------------------------------------------------------------

describe("singleSelection", () => {
  it("sets focus = anchor = path and paths = {path}", () => {
    const sel = singleSelection("/r/c");
    expect(sel.focus).toBe("/r/c");
    expect(sel.anchor).toBe("/r/c");
    // paths carries the clicked path so subsequent Cmd-click toggles see
    // the implicit single-selection as part of the base set.
    expect(sel.paths.size).toBe(1);
    expect(sel.paths.has("/r/c")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toggleInSelection
// ---------------------------------------------------------------------------

describe("toggleInSelection", () => {
  it("adds path to paths when not already present", () => {
    const before = singleSelection("/r/a");
    const after = toggleInSelection(before, "/r/b");
    expect(after.paths.has("/r/b")).toBe(true);
    expect(after.focus).toBe("/r/b");
  });

  it("removes path from paths when already present", () => {
    const before: FileSelection = {
      focus: "/r/b",
      anchor: "/r/a",
      paths: new Set(["/r/a", "/r/b"]),
    };
    const after = toggleInSelection(before, "/r/b");
    expect(after.paths.has("/r/b")).toBe(false);
    expect(after.paths.has("/r/a")).toBe(true);
  });

  it("preserves anchor from the previous selection", () => {
    const before: FileSelection = {
      focus: "/r/a",
      anchor: "/r/c",
      paths: new Set(["/r/a"]),
    };
    const after = toggleInSelection(before, "/r/b");
    expect(after.anchor).toBe("/r/c");
  });

  it("is referentially immutable (returns new object)", () => {
    const before = singleSelection("/r/a");
    const after = toggleInSelection(before, "/r/b");
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// extendSelection
// ---------------------------------------------------------------------------

describe("extendSelection", () => {
  it("selects the closed range [anchor, target] in forward direction", () => {
    const base = singleSelection("/r/b");
    const sel = extendSelection(base, "/r/b", "/r/d", flatPaths);
    expect(sel.paths.has("/r/b")).toBe(true);
    expect(sel.paths.has("/r/c")).toBe(true);
    expect(sel.paths.has("/r/d")).toBe(true);
    expect(sel.paths.has("/r/a")).toBe(false);
    expect(sel.focus).toBe("/r/d");
  });

  it("selects the closed range [anchor, target] in reverse direction", () => {
    const base = singleSelection("/r/d");
    const sel = extendSelection(base, "/r/d", "/r/b", flatPaths);
    expect(sel.paths.has("/r/b")).toBe(true);
    expect(sel.paths.has("/r/c")).toBe(true);
    expect(sel.paths.has("/r/d")).toBe(true);
    expect(sel.focus).toBe("/r/b");
  });

  it("falls back to singleSelection when anchor is not in flatPaths", () => {
    const base = singleSelection("/outside");
    const sel = extendSelection(base, "/outside", "/r/c", flatPaths);
    expect(sel.focus).toBe("/r/c");
    // singleSelection now seeds paths with the chosen path.
    expect(sel.paths.size).toBe(1);
    expect(sel.paths.has("/r/c")).toBe(true);
  });

  it("uses focus as effective anchor when explicit anchor is null", () => {
    const base: FileSelection = { focus: "/r/a", anchor: null, paths: new Set() };
    const sel = extendSelection(base, null, "/r/c", flatPaths);
    expect(sel.paths.has("/r/a")).toBe(true);
    expect(sel.paths.has("/r/b")).toBe(true);
    expect(sel.paths.has("/r/c")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectAll
// ---------------------------------------------------------------------------

describe("selectAll", () => {
  it("selects all paths, focus = last, anchor = first", () => {
    const sel = selectAll(flatPaths);
    expect(sel.paths.size).toBe(flatPaths.length);
    expect(sel.focus).toBe("/r/e");
    expect(sel.anchor).toBe("/r/a");
    for (const p of flatPaths) {
      expect(sel.paths.has(p)).toBe(true);
    }
  });

  it("returns emptySelection when flatPaths is empty", () => {
    const sel = selectAll([]);
    expect(sel.focus).toBeNull();
    expect(sel.anchor).toBeNull();
    expect(sel.paths.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// selectAllHierarchical (VSCode parity Cmd+A)
// ---------------------------------------------------------------------------

describe("selectAllHierarchical", () => {
  const ROOT = "/r";
  // Nested layout — focused row sits inside /r/dir/sub.
  //   /r
  //   ├─ a            (depth 1)
  //   ├─ dir          (depth 1)
  //   │  ├─ b         (depth 2)
  //   │  └─ sub       (depth 2)
  //   │     └─ c      (depth 3)  ← focus
  //   └─ d            (depth 1)
  const nested = ["/r/a", "/r/dir", "/r/dir/b", "/r/dir/sub", "/r/dir/sub/c", "/r/d"];

  it("first press selects the focused row's parent subtree", () => {
    const base = singleSelection("/r/dir/sub/c");
    const next = selectAllHierarchical(base, nested, ROOT);
    // scope = /r/dir/sub → candidate = ["/r/dir/sub", "/r/dir/sub/c"]
    expect(next.paths.has("/r/dir/sub")).toBe(true);
    expect(next.paths.has("/r/dir/sub/c")).toBe(true);
    expect(next.paths.has("/r/dir")).toBe(false);
    expect(next.paths.has("/r/a")).toBe(false);
    // Focus stays put.
    expect(next.focus).toBe("/r/dir/sub/c");
  });

  it("second press widens to the next level up", () => {
    let sel = singleSelection("/r/dir/sub/c");
    sel = selectAllHierarchical(sel, nested, ROOT); // 1st: /r/dir/sub subtree
    sel = selectAllHierarchical(sel, nested, ROOT); // 2nd: /r/dir subtree
    expect(sel.paths.has("/r/dir")).toBe(true);
    expect(sel.paths.has("/r/dir/b")).toBe(true);
    expect(sel.paths.has("/r/dir/sub")).toBe(true);
    expect(sel.paths.has("/r/dir/sub/c")).toBe(true);
    expect(sel.paths.has("/r/a")).toBe(false);
    expect(sel.paths.has("/r/d")).toBe(false);
  });

  it("walks all the way up to the workspace root (full flat selection)", () => {
    let sel = singleSelection("/r/dir/sub/c");
    sel = selectAllHierarchical(sel, nested, ROOT); // scope: /r/dir/sub
    sel = selectAllHierarchical(sel, nested, ROOT); // scope: /r/dir
    sel = selectAllHierarchical(sel, nested, ROOT); // scope: /r (root)
    for (const p of nested) {
      expect(sel.paths.has(p)).toBe(true);
    }
  });

  it("returns sel unchanged when flatPaths is empty", () => {
    const sel = singleSelection("/r/dir/sub/c");
    const next = selectAllHierarchical(sel, [], ROOT);
    expect(next).toBe(sel);
  });
});
