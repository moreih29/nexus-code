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
  test("returns true for a file with a conflict block", () => {
    expect(hasConflictMarkers(twoWayBlock("a", "b"))).toBe(true);
  });

  test("returns false for a file with no conflict markers", () => {
    expect(hasConflictMarkers("const x = 1;\nconsole.log(x);\n")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(hasConflictMarkers("")).toBe(false);
  });

  test("returns true when marker is mid-file (preceded by newline)", () => {
    const text = "normal line\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b";
    expect(hasConflictMarkers(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Single 2-way block
// ---------------------------------------------------------------------------

describe("parseConflictBlocks — single 2-way block", () => {
  const text = twoWayBlock("ours line", "theirs line");

  test("returns exactly one block", () => {
    expect(parseConflictBlocks(text)).toHaveLength(1);
  });

  test("block index is 0", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.index).toBe(0);
  });

  test("blockRange spans from <<<<<<<  to >>>>>>>", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.blockRange.startLine).toBe(1);
    expect(block.blockRange.endLine).toBe(5);
  });

  test("currentMarkerLine is 1", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.currentMarkerLine).toBe(1);
  });

  test("current section spans line 2", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.current.startLine).toBe(2);
    expect(block.current.endLine).toBe(2);
  });

  test("base is null for 2-way block", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.base).toBeNull();
    expect(block.baseMarkerLine).toBeNull();
  });

  test("separatorLine is 3", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.separatorLine).toBe(3);
  });

  test("incoming section spans line 4", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.incoming.startLine).toBe(4);
    expect(block.incoming.endLine).toBe(4);
  });

  test("incomingMarkerLine is 5", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.incomingMarkerLine).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// diff3 block (with ||||||| base)
// ---------------------------------------------------------------------------

describe("parseConflictBlocks — diff3 base section", () => {
  const text = diff3Block("ours line", "base line", "theirs line");

  test("returns one block", () => {
    expect(parseConflictBlocks(text)).toHaveLength(1);
  });

  test("baseMarkerLine is 3", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.baseMarkerLine).toBe(3);
  });

  test("base section spans line 4", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.base).not.toBeNull();
    expect(block.base!.startLine).toBe(4);
    expect(block.base!.endLine).toBe(4);
  });

  test("current section ends before base marker", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.current.endLine).toBe(2);
  });

  test("separator is at line 5", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.separatorLine).toBe(5);
  });

  test("incoming spans line 6", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.incoming.startLine).toBe(6);
    expect(block.incoming.endLine).toBe(6);
  });

  test("blockRange ends at line 7 (>>>>>>>)", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.blockRange.endLine).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Multiple blocks
// ---------------------------------------------------------------------------

describe("parseConflictBlocks — multiple blocks", () => {
  const text = [
    "prefix",
    twoWayBlock("ours-1", "theirs-1"),
    "middle",
    twoWayBlock("ours-2", "theirs-2"),
    "suffix",
  ].join("\n");

  test("returns two blocks", () => {
    expect(parseConflictBlocks(text)).toHaveLength(2);
  });

  test("blocks are ordered top-to-bottom", () => {
    const [b0, b1] = parseConflictBlocks(text);
    expect(b0.blockRange.startLine).toBeLessThan(b1.blockRange.startLine);
  });

  test("block indices are 0 and 1", () => {
    const [b0, b1] = parseConflictBlocks(text);
    expect(b0.index).toBe(0);
    expect(b1.index).toBe(1);
  });

  test("blocks do not overlap", () => {
    const [b0, b1] = parseConflictBlocks(text);
    expect(b0.blockRange.endLine).toBeLessThan(b1.blockRange.startLine);
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
  test("returns empty array for clean file", () => {
    const text = "function hello() {\n  return 42;\n}\n";
    expect(parseConflictBlocks(text)).toHaveLength(0);
  });

  test("returns empty array for empty string", () => {
    expect(parseConflictBlocks("")).toHaveLength(0);
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
    // The malformed block causes the parser to scan past it; the complete
    // block should still be found.
    const blocks = parseConflictBlocks(text);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const lastBlock = blocks[blocks.length - 1];
    expect(lastBlock).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-line content sections
// ---------------------------------------------------------------------------

describe("parseConflictBlocks — multi-line content", () => {
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

  test("current section spans 3 lines", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.current.startLine).toBe(2);
    expect(block.current.endLine).toBe(4);
  });

  test("incoming section spans 2 lines", () => {
    const [block] = parseConflictBlocks(text);
    expect(block.incoming.startLine).toBe(6);
    expect(block.incoming.endLine).toBe(7);
  });
});
