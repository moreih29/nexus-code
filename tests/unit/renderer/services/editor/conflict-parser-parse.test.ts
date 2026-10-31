/**
 * conflict-parser — parse aspect unit tests.
 *
 * Covers `parseConflictBlocks` and `hasConflictMarkers` across:
 *   - Single conflict block (2-way merge)
 *   - Multiple conflict blocks in the same file
 *   - diff3 base section (`|||||||` marker)
 *   - Empty content sections (adjacent markers)
 *   - No-trailing-newline files
 *   - Files without conflict markers (must return empty array / false)
 *   - Malformed / incomplete blocks (must be skipped gracefully)
 *
 * No Monaco or IPC dependencies — the parser is pure data.
 */

import { describe, expect, test } from "bun:test";
import {
  hasConflictMarkers,
  parseConflictBlocks,
} from "../../../../../src/renderer/services/editor/conflict/conflict-parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal 2-way conflict block string. */
function twoWayBlock(ours: string, theirs: string): string {
  return [`<<<<<<< HEAD`, ours, `=======`, theirs, `>>>>>>> branch`].join("\n");
}

/** Builds a diff3-style conflict block string. */
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

// ---------------------------------------------------------------------------
// hasConflictMarkers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Block shapes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Empty content sections
// ---------------------------------------------------------------------------

describe("parseConflictBlocks — empty sections", () => {
  test("handles empty current side (markers adjacent)", () => {
    const text = ["<<<<<<< HEAD", "=======", "theirs", ">>>>>>> b"].join("\n");
    const [block] = parseConflictBlocks(text);
    // current section startLine > endLine means zero lines (empty)
    expect(block.current.startLine).toBeGreaterThan(block.current.endLine);
  });

  test("handles empty incoming side (markers adjacent)", () => {
    const text = ["<<<<<<< HEAD", "ours", "=======", ">>>>>>> b"].join("\n");
    const [block] = parseConflictBlocks(text);
    expect(block.incoming.startLine).toBeGreaterThan(block.incoming.endLine);
  });
});

// ---------------------------------------------------------------------------
// No-trailing-newline
// ---------------------------------------------------------------------------

describe("parseConflictBlocks — no trailing newline", () => {
  test("parses block correctly when file has no trailing newline", () => {
    // Intentionally no `\n` at the end of the last marker.
    const text = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b";
    const blocks = parseConflictBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].incomingMarkerLine).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Files without conflict markers
// ---------------------------------------------------------------------------

describe("parseConflictBlocks — no markers", () => {
  test("returns an empty array for a clean file or an empty string", () => {
    expect(parseConflictBlocks("function hello() {\n  return 42;\n}\n")).toEqual([]);
    expect(parseConflictBlocks("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Malformed / incomplete blocks
// ---------------------------------------------------------------------------

describe("parseConflictBlocks — malformed blocks", () => {
  test("skips block missing closing marker", () => {
    const text = "<<<<<<< HEAD\nours\n=======\ntheirs\n";
    // No `>>>>>>>` — block is incomplete
    expect(parseConflictBlocks(text)).toHaveLength(0);
  });

  test("skips block missing separator", () => {
    const text = "<<<<<<< HEAD\nours\n>>>>>>> b\n";
    expect(parseConflictBlocks(text)).toHaveLength(0);
  });

  test("complete block after malformed block is still parsed", () => {
    // Incomplete block followed by a complete one.
    const text = [
      "<<<<<<< HEAD",
      "ours-bad",
      // missing separator + >>>>>>>
      "normal code",
      twoWayBlock("ours-good", "theirs-good"),
    ].join("\n");
    // The malformed block causes the parser to scan past it; only the
    // complete block on lines 4-8 is found.
    const blocks = parseConflictBlocks(text);
    expect(blocks.map(({ index, blockRange }) => ({ index, blockRange }))).toEqual([
      { index: 0, blockRange: { startLine: 4, endLine: 8 } },
    ]);
  });
});
