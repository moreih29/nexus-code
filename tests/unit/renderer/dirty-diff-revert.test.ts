// Verifies the edit behind the dirty-diff peek's "Revert Change": applying it
// to the buffer restores the baseline for that change. Changes are written in
// the shape mapChangesToDirty produces from monaco's diff mappings.

import { describe, expect, test } from "bun:test";
import {
  type RevertEdit,
  revertChangeEdit,
} from "../../../src/renderer/services/editor/git/dirty-diff/revert";
import type { DirtyChange } from "../../../src/renderer/services/editor/git/dirty-diff/types";

/** A model over `text` whose lines and columns follow monaco's conventions. */
function modelOf(text: string, eol = "\n") {
  const lines = text.split(eol);
  return {
    lines,
    getLineCount: () => lines.length,
    getLineMaxColumn: (lineNumber: number) => lines[lineNumber - 1].length + 1,
    getEOL: () => eol,
  };
}

function apply(text: string, edit: RevertEdit, eol = "\n"): string {
  const lines = text.split(eol);
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + eol.length, 0) + column - 1;
  const { startLineNumber, startColumn, endLineNumber, endColumn } = edit.range;
  return (
    text.slice(0, offset(startLineNumber, startColumn)) +
    edit.text +
    text.slice(offset(endLineNumber, endColumn))
  );
}

function revert(original: string, modified: string, change: DirtyChange, eol = "\n"): string {
  const edit = revertChangeEdit(change, original.split(eol), modelOf(modified, eol));
  return apply(modified, edit, eol);
}

function change(
  type: DirtyChange["type"],
  original: [number, number],
  modified: [number, number],
): DirtyChange {
  return {
    type,
    originalStartLineNumber: original[0],
    originalEndLineNumber: original[1],
    modifiedStartLineNumber: modified[0],
    modifiedEndLineNumber: modified[1],
  };
}

describe("revertChangeEdit", () => {
  test("puts modified lines back", () => {
    expect(revert("a\nb\nc\n", "a\nX\nY\nc\n", change("modify", [2, 2], [2, 3]))).toBe("a\nb\nc\n");
  });

  test("removes added lines", () => {
    expect(revert("a\nc\n", "a\nb\nc\n", change("add", [2, 0], [2, 2]))).toBe("a\nc\n");
    expect(revert("b\n", "a\nb\n", change("add", [1, 0], [1, 1]))).toBe("b\n");
  });

  test("removes lines added at the end of a file without a trailing newline", () => {
    expect(revert("a", "a\nb\nc", change("add", [2, 0], [2, 3]))).toBe("a");
  });

  test("restores deleted lines", () => {
    expect(revert("a\nb\nc\n", "a\nc\n", change("delete", [2, 2], [2, 0]))).toBe("a\nb\nc\n");
    expect(revert("a\nb\n", "b\n", change("delete", [1, 1], [1, 0]))).toBe("a\nb\n");
  });

  test("restores lines deleted from the end of a file without a trailing newline", () => {
    expect(revert("a\nb\nc", "a", change("delete", [2, 3], [2, 0]))).toBe("a\nb\nc");
  });

  test("writes the buffer's line breaks", () => {
    expect(revert("a\r\nb\r\nc", "a\r\nc", change("delete", [2, 2], [2, 0]), "\r\n")).toBe(
      "a\r\nb\r\nc",
    );
  });

  test("leaves the other changes alone", () => {
    const modified = "a\nX\nc\nd\nY\n";
    expect(revert("a\nb\nc\nd\ne\n", modified, change("modify", [5, 5], [5, 5]))).toBe(
      "a\nX\nc\nd\ne\n",
    );
  });
});
