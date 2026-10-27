// Verifies the snippets the dirty-diff peek diffs: both sides carry the same
// context lines, so only the change itself shows as added or removed.

import { describe, expect, test } from "bun:test";
import { sliceSnippet } from "../../../src/renderer/services/editor/git/dirty-diff/peek";

const lines = (text: string) => text.split("\n");

describe("sliceSnippet", () => {
  test("takes the changed lines with two lines of context", () => {
    expect(sliceSnippet(lines("a\nb\nc\nd\ne\nf\n"), 3, 4)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(sliceSnippet(lines("a\nb\nc\nd\ne\nf\ng\n"), 4, 4)).toEqual(["b", "c", "d", "e", "f"]);
  });

  test("gives an empty side the context around its gap", () => {
    // "x" added before line 3 of the original.
    const original = sliceSnippet(lines("a\nb\nc\nd\n"), 3, 0);
    const modified = sliceSnippet(lines("a\nb\nx\nc\nd\n"), 3, 3);
    expect(original).toEqual(["a", "b", "c", "d"]);
    expect(modified).toEqual(["a", "b", "x", "c", "d"]);
  });

  test("clamps the context at the ends of the document", () => {
    expect(sliceSnippet(lines("a\nb\n"), 3, 0)).toEqual(["a", "b", ""]);
    expect(sliceSnippet(lines("x\na\n"), 1, 1)).toEqual(["x", "a", ""]);
  });
});
