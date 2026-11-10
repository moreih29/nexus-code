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
  singleSelection,
} from "../../../../../../src/renderer/state/stores/files/selection";
import type { FileSelection } from "../../../../../../src/renderer/state/stores/files/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const flatPaths = ["/r/a", "/r/b", "/r/c", "/r/d", "/r/e"];

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
