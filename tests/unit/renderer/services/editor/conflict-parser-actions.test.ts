/**
 * conflict-parser — accept-action aspect unit tests.
 *
 * Verifies that `acceptCurrent`, `acceptIncoming`, and `acceptBoth` produce
 * the correct output text for:
 *   - 2-way conflict (no base section)
 *   - diff3 conflict (with ||||||| base section)
 *   - Multiple blocks (action applies only to the targeted block)
 *   - No-trailing-newline files
 *   - Empty current / incoming sections
 *
 * No Monaco or IPC dependencies — the accept functions are pure string transforms.
 */

import { describe, expect, test } from "bun:test";
import {
  acceptBoth,
  acceptCurrent,
  acceptIncoming,
  parseConflictBlocks,
} from "../../../../../src/renderer/services/editor/conflict/conflict-parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function twoWayText(ours: string[], theirs: string[]): string {
  return ["<<<<<<< HEAD", ...ours, "=======", ...theirs, ">>>>>>> branch"].join("\n");
}

function diff3Text(ours: string[], base: string[], theirs: string[]): string {
  return [
    "<<<<<<< HEAD",
    ...ours,
    "||||||| ancestor",
    ...base,
    "=======",
    ...theirs,
    ">>>>>>> branch",
  ].join("\n");
}

/** Parses the first block from text (asserts existence). */
function firstBlock(text: string) {
  const blocks = parseConflictBlocks(text);
  if (blocks.length === 0) throw new Error("No conflict blocks found in test fixture");
  return blocks[0];
}

// ---------------------------------------------------------------------------
// acceptCurrent — 2-way
// ---------------------------------------------------------------------------

describe("acceptCurrent — 2-way", () => {
  const text = twoWayText(["ours content"], ["theirs content"]);
  const block = firstBlock(text);

  test("replaces the whole block with only the current side", () => {
    const result = acceptCurrent(text, block);
    expect(result).toBe("ours content");
  });

  test("removes all markers", () => {
    const result = acceptCurrent(text, block);
    expect(result).not.toContain("<<<<<<<");
    expect(result).not.toContain("=======");
    expect(result).not.toContain(">>>>>>>");
  });
});

// ---------------------------------------------------------------------------
// acceptIncoming — 2-way
// ---------------------------------------------------------------------------

describe("acceptIncoming — 2-way", () => {
  const text = twoWayText(["ours content"], ["theirs content"]);
  const block = firstBlock(text);

  test("replaces the whole block with only the incoming side", () => {
    const result = acceptIncoming(text, block);
    expect(result).toBe("theirs content");
  });

  test("removes all markers", () => {
    const result = acceptIncoming(text, block);
    expect(result).not.toContain("<<<<<<<");
    expect(result).not.toContain("=======");
    expect(result).not.toContain(">>>>>>>");
  });
});

// ---------------------------------------------------------------------------
// acceptBoth — 2-way
// ---------------------------------------------------------------------------

describe("acceptBoth — 2-way", () => {
  const text = twoWayText(["ours content"], ["theirs content"]);
  const block = firstBlock(text);

  test("concatenates current then incoming, removing markers", () => {
    const result = acceptBoth(text, block);
    expect(result).toBe("ours content\ntheirs content");
  });

  test("removes all markers", () => {
    const result = acceptBoth(text, block);
    expect(result).not.toContain("<<<<<<<");
    expect(result).not.toContain("|||||||");
    expect(result).not.toContain("=======");
    expect(result).not.toContain(">>>>>>>");
  });
});

// ---------------------------------------------------------------------------
// diff3 base — acceptCurrent discards base
// ---------------------------------------------------------------------------

describe("acceptCurrent — diff3", () => {
  const text = diff3Text(["ours content"], ["base content"], ["theirs content"]);
  const block = firstBlock(text);

  test("keeps current, discards base and incoming", () => {
    const result = acceptCurrent(text, block);
    expect(result).toBe("ours content");
    expect(result).not.toContain("base content");
    expect(result).not.toContain("theirs content");
  });
});

describe("acceptIncoming — diff3", () => {
  const text = diff3Text(["ours content"], ["base content"], ["theirs content"]);
  const block = firstBlock(text);

  test("keeps incoming, discards base and current", () => {
    const result = acceptIncoming(text, block);
    expect(result).toBe("theirs content");
    expect(result).not.toContain("base content");
    expect(result).not.toContain("ours content");
  });
});

describe("acceptBoth — diff3", () => {
  const text = diff3Text(["ours content"], ["base content"], ["theirs content"]);
  const block = firstBlock(text);

  test("concatenates current + incoming, discards base", () => {
    const result = acceptBoth(text, block);
    expect(result).toBe("ours content\ntheirs content");
    expect(result).not.toContain("base content");
  });
});

// ---------------------------------------------------------------------------
// Multiple blocks — action targets only the specified block
// ---------------------------------------------------------------------------

describe("accept actions — multiple blocks", () => {
  const prefix = "prefix line";
  const block0Text = twoWayText(["ours-0"], ["theirs-0"]);
  const middle = "middle line";
  const block1Text = twoWayText(["ours-1"], ["theirs-1"]);
  const suffix = "suffix line";
  const fullText = [prefix, block0Text, middle, block1Text, suffix].join("\n");

  test("acceptCurrent on block 0 only resolves the first block", () => {
    const blocks = parseConflictBlocks(fullText);
    const result = acceptCurrent(fullText, blocks[0]);
    // Block 0 should be replaced; block 1 markers should still be present.
    expect(result).toContain("ours-0");
    expect(result).not.toContain("theirs-0");
    expect(result).toContain("<<<<<<<");
    expect(result).toContain("ours-1");
    expect(result).toContain("theirs-1");
  });

  test("acceptIncoming on block 1 only resolves the second block", () => {
    const blocks = parseConflictBlocks(fullText);
    const result = acceptIncoming(fullText, blocks[1]);
    expect(result).toContain("theirs-1");
    expect(result).not.toContain("ours-1");
    // Block 0 markers still present.
    expect(result).toContain("ours-0");
    expect(result).toContain("theirs-0");
    expect(result).toContain("<<<<<<<");
  });

  test("surrounding non-conflict text is preserved", () => {
    const blocks = parseConflictBlocks(fullText);
    const result = acceptCurrent(fullText, blocks[0]);
    expect(result).toContain(prefix);
    expect(result).toContain(middle);
    expect(result).toContain(suffix);
  });
});

// ---------------------------------------------------------------------------
// No-trailing-newline
// ---------------------------------------------------------------------------

describe("accept actions — no trailing newline", () => {
  // File without trailing newline.
  const text = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b";
  const block = firstBlock(text);

  test("acceptCurrent works on no-trailing-newline file", () => {
    const result = acceptCurrent(text, block);
    expect(result).toBe("ours");
  });

  test("acceptIncoming works on no-trailing-newline file", () => {
    const result = acceptIncoming(text, block);
    expect(result).toBe("theirs");
  });
});

// ---------------------------------------------------------------------------
// Empty sections
// ---------------------------------------------------------------------------

describe("accept actions — empty sections", () => {
  test("acceptCurrent with empty current returns empty string for that block", () => {
    const text = ["<<<<<<< HEAD", "=======", "theirs", ">>>>>>> b"].join("\n");
    const block = firstBlock(text);
    const result = acceptCurrent(text, block);
    // The current section is empty — result should have nothing from the block.
    expect(result).not.toContain("theirs");
    expect(result).not.toContain("<<<<<<<");
    expect(result).not.toContain("=======");
    expect(result).not.toContain(">>>>>>>");
  });

  test("acceptIncoming with empty incoming returns empty string for that block", () => {
    const text = ["<<<<<<< HEAD", "ours", "=======", ">>>>>>> b"].join("\n");
    const block = firstBlock(text);
    const result = acceptIncoming(text, block);
    expect(result).not.toContain("ours");
    expect(result).not.toContain("<<<<<<<");
    expect(result).not.toContain("=======");
    expect(result).not.toContain(">>>>>>>");
  });

  test("acceptBoth with empty current yields only incoming", () => {
    const text = ["<<<<<<< HEAD", "=======", "theirs", ">>>>>>> b"].join("\n");
    const block = firstBlock(text);
    const result = acceptBoth(text, block);
    expect(result).toBe("theirs");
  });
});

// ---------------------------------------------------------------------------
// Multi-line sections
// ---------------------------------------------------------------------------

describe("accept actions — multi-line sections", () => {
  const text = twoWayText(["line A", "line B", "line C"], ["line X", "line Y"]);
  const block = firstBlock(text);

  test("acceptCurrent preserves all ours lines", () => {
    const result = acceptCurrent(text, block);
    expect(result).toBe("line A\nline B\nline C");
  });

  test("acceptIncoming preserves all theirs lines", () => {
    const result = acceptIncoming(text, block);
    expect(result).toBe("line X\nline Y");
  });

  test("acceptBoth concatenates all lines in order", () => {
    const result = acceptBoth(text, block);
    expect(result).toBe("line A\nline B\nline C\nline X\nline Y");
  });
});

// ---------------------------------------------------------------------------
// Surrounding context preservation
// ---------------------------------------------------------------------------

describe("accept actions — context preservation", () => {
  const text = ["before line", twoWayText(["ours"], ["theirs"]), "after line"].join("\n");
  const block = firstBlock(text);

  test("acceptCurrent keeps content before and after the block", () => {
    const result = acceptCurrent(text, block);
    expect(result).toBe("before line\nours\nafter line");
  });

  test("acceptIncoming keeps content before and after the block", () => {
    const result = acceptIncoming(text, block);
    expect(result).toBe("before line\ntheirs\nafter line");
  });

  test("acceptBoth keeps content before and after the block", () => {
    const result = acceptBoth(text, block);
    expect(result).toBe("before line\nours\ntheirs\nafter line");
  });
});
