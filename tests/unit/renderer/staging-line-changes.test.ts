// Verifies the index text staging part of a file writes: the index with the
// chosen changes taken from the working text, or put back to HEAD's when
// unstaging. Diffs come from monaco's own computer, as in the app.

import { describe, expect, test } from "bun:test";
import { computeDirtyChanges } from "../../../src/renderer/services/editor/git/dirty-diff/compute";
import {
  applyLineChanges,
  invertLineChange,
  type LineChange,
  type LineRange,
  lineChangeOfDirty,
  lineChangeOfMonaco,
  selectChanges,
  selectedLineRange,
  splitLines,
} from "../../../src/renderer/services/editor/git/staging/line-changes";

function diff(original: string, modified: string): LineChange[] {
  return computeDirtyChanges(original, modified, false).map(lineChangeOfDirty);
}

function lines(start: number, endInclusive: number): LineRange {
  return { startLineNumber: start, endLineNumberExclusive: endInclusive + 1 };
}

/** The index after staging the working lines in `ranges`. */
function stage(index: string, working: string, ranges: LineRange[], eol = "\n"): string {
  const picked = selectChanges(diff(index, working), ranges);
  return applyLineChanges(index, splitLines(working).lines, picked, eol);
}

/** The index after unstaging its lines in `ranges` back to HEAD. */
function unstage(head: string, index: string, ranges: LineRange[]): string {
  const picked = selectChanges(diff(head, index), ranges).map(invertLineChange);
  return applyLineChanges(index, splitLines(head).lines, picked, "\n");
}

const everything = [lines(1, 1000)];

describe("staging whole files", () => {
  const cases: [string, string][] = [
    ["a\nb\nc\n", "a\nX\nc\nd\n"],
    ["a\nb", "a\nb\nc"],
    ["a\nb\n", "a\nb"],
    ["", "x\ny\n"],
    ["x\ny\n", ""],
    ["one\ntwo\nthree\nfour\n", "zero\none\nthree\nfour!\n"],
  ];

  test.each(
    cases,
  )("staging every change of %j turns it into the working text", (index, working) => {
    expect(stage(index, working, everything)).toBe(working);
  });

  test.each(cases)("unstaging every change of %j puts HEAD back", (head, index) => {
    expect(unstage(head, index, everything)).toBe(head);
  });
});

describe("staging part of a file", () => {
  const index = "a\nb\nc\nd\ne\nf\ng\n";
  const working = "a\nB\nc\nd\ne\nF\ng\n";

  test("stages the change a range reaches and leaves the others", () => {
    expect(stage(index, working, [lines(2, 2)])).toBe("a\nB\nc\nd\ne\nf\ng\n");
    expect(stage(index, working, [lines(6, 6)])).toBe("a\nb\nc\nd\ne\nF\ng\n");
  });

  test("stages nothing for a range between changes", () => {
    expect(stage(index, working, [lines(4, 4)])).toBe(index);
  });

  test("takes lines one by one from a change with as many lines on each side", () => {
    expect(stage("a\nb\nc\nd\n", "a\nB\nC\nd\n", [lines(3, 3)])).toBe("a\nb\nC\nd\n");
  });

  test("replaces all original lines with the chosen ones otherwise", () => {
    expect(stage("a\nb\nz\n", "a\nX\nY\nZ\nz\n", [lines(2, 3)])).toBe("a\nX\nY\nz\n");
  });

  test("stages added lines one range at a time", () => {
    expect(stage("a\nd\n", "a\nb\nc\nd\n", [lines(3, 3)])).toBe("a\nc\nd\n");
  });

  test("stages a deletion from either line beside its gap", () => {
    const original = "a\nb\nc\n";
    const deleted = "a\nc\n";
    expect(stage(original, deleted, [lines(1, 1)])).toBe(deleted);
    expect(stage(original, deleted, [lines(2, 2)])).toBe(deleted);
    expect(stage("a\nb\nc\nd\n", "a\nc\nd\n", [lines(3, 3)])).toBe("a\nb\nc\nd\n");
  });

  test("an empty range at a deletion's gap stages it", () => {
    expect(stage("a\nb\nc\n", "a\nc\n", [{ startLineNumber: 2, endLineNumberExclusive: 2 }])).toBe(
      "a\nc\n",
    );
  });

  test("unstages only the chosen change", () => {
    const head = "a\nb\nc\nd\n";
    const staged = "a\nB\nc\nD\n";
    expect(unstage(head, staged, [lines(4, 4)])).toBe("a\nB\nc\nd\n");
  });
});

describe("line breaks", () => {
  test("keeps the index's own breaks and gives new lines its first one", () => {
    expect(stage("a\r\nb\r\nc\r\n", "a\nX\nc\nY\n", everything, "\n")).toBe("a\r\nX\r\nc\r\nY\r\n");
  });

  test("falls back to the given break for a one-line index", () => {
    expect(stage("a", "a\r\nb", everything, "\r\n")).toBe("a\r\nb");
  });
});

describe("change conversions", () => {
  test("reads a diff editor change's empty side as sitting after its start line", () => {
    expect(
      lineChangeOfMonaco({
        originalStartLineNumber: 2,
        originalEndLineNumber: 3,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 0,
      }),
    ).toEqual({
      original: lines(2, 3),
      modified: { startLineNumber: 2, endLineNumberExclusive: 2 },
    });
  });

  test("leaves out the line a selection ends at the start of", () => {
    expect(selectedLineRange({ startLineNumber: 2, endLineNumber: 4, endColumn: 1 })).toEqual(
      lines(2, 3),
    );
    expect(selectedLineRange({ startLineNumber: 2, endLineNumber: 2, endColumn: 1 })).toEqual(
      lines(2, 2),
    );
  });
});
