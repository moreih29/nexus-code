import { describe, expect, test } from "bun:test";
import {
  hasConflictMarkers,
  parseConflictBlocks,
} from "../../../../../src/renderer/services/editor/conflict/conflict-parser";

function twoWayBlock(ours: string, theirs: string): string {
  return [`<<<<<<< HEAD`, ours, `=======`, theirs, `>>>>>>> branch`].join("\n");
}

function diff3Block(ours: string, base: string, theirs: string): string {
  return [
    `<<<<<<< HEAD`,
    ours,
    `||||||| common ancestor`,
    base,
    `=======`,
    theirs,
    `>>>>>>> branch`,
  ].join("\n");
}

describe("hasConflictMarkers", () => {
  test.each([
    ["a file with a conflict block", twoWayBlock("a", "b"), true],
    ["a marker mid-file", "normal line\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b", true],
    ["a file with no conflict markers", "const x = 1;\nconsole.log(x);\n", false],
    ["an empty string", "", false],
  ])("%s → %p", (_name, text, expected) => {
    expect(hasConflictMarkers(text)).toBe(expected);
  });
});

describe("parseConflictBlocks — block shape", () => {
  test("2-way block: every marker and section line", () => {
    expect(parseConflictBlocks(twoWayBlock("ours line", "theirs line"))).toEqual([
      {
        index: 0,
        blockRange: { startLine: 1, endLine: 5 },
        currentMarkerLine: 1,
        current: { startLine: 2, endLine: 2 },
        base: null,
        baseMarkerLine: null,
        separatorLine: 3,
        incoming: { startLine: 4, endLine: 4 },
        incomingMarkerLine: 5,
      },
    ]);
  });

  test("diff3 block: the base section sits between current and incoming", () => {
    expect(parseConflictBlocks(diff3Block("ours line", "base line", "theirs line"))).toEqual([
      {
        index: 0,
        blockRange: { startLine: 1, endLine: 7 },
        currentMarkerLine: 1,
        current: { startLine: 2, endLine: 2 },
        base: { startLine: 4, endLine: 4 },
        baseMarkerLine: 3,
        separatorLine: 5,
        incoming: { startLine: 6, endLine: 6 },
        incomingMarkerLine: 7,
      },
    ]);
  });

  test("multi-line sections span every content line", () => {
    const text = [
      "<<<<<<< HEAD",
      "ours line 1",
      "ours line 2",
      "ours line 3",
      "=======",
      "theirs line 1",
      "theirs line 2",
      ">>>>>>> branch",
    ].join("\n");
    const [block] = parseConflictBlocks(text);
    expect(block.current).toEqual({ startLine: 2, endLine: 4 });
    expect(block.incoming).toEqual({ startLine: 6, endLine: 7 });
  });

  test("multiple blocks are indexed top to bottom", () => {
    const text = [
      "prefix",
      twoWayBlock("ours-1", "theirs-1"),
      "middle",
      twoWayBlock("ours-2", "theirs-2"),
      "suffix",
    ].join("\n");
    const blocks = parseConflictBlocks(text);
    expect(blocks.map(({ index, blockRange }) => ({ index, blockRange }))).toEqual([
      { index: 0, blockRange: { startLine: 2, endLine: 6 } },
      { index: 1, blockRange: { startLine: 8, endLine: 12 } },
    ]);
  });
});

describe("parseConflictBlocks — empty sections", () => {
  test("handles empty current side (markers adjacent)", () => {
    const text = ["<<<<<<< HEAD", "=======", "theirs", ">>>>>>> b"].join("\n");
    const [block] = parseConflictBlocks(text);
    expect(block.current.startLine).toBeGreaterThan(block.current.endLine);
  });

  test("handles empty incoming side (markers adjacent)", () => {
    const text = ["<<<<<<< HEAD", "ours", "=======", ">>>>>>> b"].join("\n");
    const [block] = parseConflictBlocks(text);
    expect(block.incoming.startLine).toBeGreaterThan(block.incoming.endLine);
  });
});

describe("parseConflictBlocks — no trailing newline", () => {
  test("parses block correctly when file has no trailing newline", () => {
    const text = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b";
    const blocks = parseConflictBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].incomingMarkerLine).toBe(5);
  });
});

describe("parseConflictBlocks — no markers", () => {
  test("returns an empty array for a clean file or an empty string", () => {
    expect(parseConflictBlocks("function hello() {\n  return 42;\n}\n")).toEqual([]);
    expect(parseConflictBlocks("")).toEqual([]);
  });
});

describe("parseConflictBlocks — malformed blocks", () => {
  test("skips block missing closing marker", () => {
    const text = "<<<<<<< HEAD\nours\n=======\ntheirs\n";
    expect(parseConflictBlocks(text)).toHaveLength(0);
  });

  test("skips block missing separator", () => {
    const text = "<<<<<<< HEAD\nours\n>>>>>>> b\n";
    expect(parseConflictBlocks(text)).toHaveLength(0);
  });

  test("complete block after malformed block is still parsed", () => {
    const text = [
      "<<<<<<< HEAD",
      "ours-bad",
      "normal code",
      twoWayBlock("ours-good", "theirs-good"),
    ].join("\n");
    const blocks = parseConflictBlocks(text);
    expect(blocks.map(({ index, blockRange }) => ({ index, blockRange }))).toEqual([
      { index: 0, blockRange: { startLine: 4, endLine: 8 } },
    ]);
  });
});
