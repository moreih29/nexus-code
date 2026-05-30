// Verifies the pure transform that backs the in-editor dirty-diff gutter:
// monaco's diff mappings → our DirtyChange model (add/modify/delete
// classification + 1-based inclusive line numbers with empty-side collapse).
//
// We feed synthetic LineRange-shaped mappings rather than running monaco's diff
// engine: the engine is exercised by the app bundler, and its bare-specifier
// internal module does not resolve under the bun test runner. The mapping logic
// — where our own bugs would live — is fully covered here.

import { describe, expect, test } from "bun:test";
import { mapChangesToDirty } from "../../../src/renderer/services/editor/git/dirty-diff/map";

/** Builds a monaco-style LineRange [start, endExclusive). */
function range(startLineNumber: number, endLineNumberExclusive: number) {
  return {
    startLineNumber,
    endLineNumberExclusive,
    isEmpty: startLineNumber === endLineNumberExclusive,
  };
}

describe("mapChangesToDirty", () => {
  test("empty input yields no changes", () => {
    expect(mapChangesToDirty([])).toEqual([]);
  });

  test("classifies a pure insertion as 'add' with empty original side", () => {
    // Inserted line 2 in modified; original collapses at the boundary.
    const [change] = mapChangesToDirty([{ original: range(2, 2), modified: range(2, 3) }]);

    expect(change.type).toBe("add");
    expect(change.modifiedStartLineNumber).toBe(2);
    expect(change.modifiedEndLineNumber).toBe(2);
    expect(change.originalEndLineNumber).toBe(0);
  });

  test("classifies a pure deletion as 'delete' with empty modified side", () => {
    const [change] = mapChangesToDirty([{ original: range(2, 3), modified: range(2, 2) }]);

    expect(change.type).toBe("delete");
    expect(change.originalStartLineNumber).toBe(2);
    expect(change.originalEndLineNumber).toBe(2);
    expect(change.modifiedEndLineNumber).toBe(0);
  });

  test("classifies an in-place edit as 'modify' on both sides", () => {
    const [change] = mapChangesToDirty([{ original: range(2, 3), modified: range(2, 3) }]);

    expect(change.type).toBe("modify");
    expect(change.modifiedStartLineNumber).toBe(2);
    expect(change.modifiedEndLineNumber).toBe(2);
    expect(change.originalStartLineNumber).toBe(2);
    expect(change.originalEndLineNumber).toBe(2);
  });

  test("converts multi-line exclusive ranges to inclusive ends", () => {
    // Original lines 2..4 (exclusive 5) replaced by modified lines 2..3 (exclusive 4).
    const [change] = mapChangesToDirty([{ original: range(2, 5), modified: range(2, 4) }]);

    expect(change.type).toBe("modify");
    expect(change.originalEndLineNumber).toBe(4);
    expect(change.modifiedEndLineNumber).toBe(3);
  });

  test("preserves order and per-change classification across many changes", () => {
    const changes = mapChangesToDirty([
      { original: range(2, 3), modified: range(2, 3) }, // modify
      { original: range(6, 6), modified: range(6, 7) }, // add
    ]);

    expect(changes.map((c) => c.type)).toEqual(["modify", "add"]);
    expect(changes[0].modifiedStartLineNumber).toBeLessThan(changes[1].modifiedStartLineNumber);
  });
});
