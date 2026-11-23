import { describe, expect, test } from "bun:test";
import {
  acceptBoth,
  acceptCurrent,
  acceptIncoming,
  parseConflictBlocks,
} from "../../../../../src/renderer/services/editor/conflict/conflict-parser";

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

function firstBlock(text: string) {
  const blocks = parseConflictBlocks(text);
  if (blocks.length === 0) throw new Error("No conflict blocks found in test fixture");
  return blocks[0];
}

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
    expect(result).toBe([prefix, "ours-0", middle, block1Text, suffix].join("\n"));
  });

  test("acceptIncoming on block 1 only resolves the second block", () => {
    const blocks = parseConflictBlocks(fullText);
    const result = acceptIncoming(fullText, blocks[1]);
    expect(result).toBe([prefix, block0Text, middle, "theirs-1", suffix].join("\n"));
  });
});

describe("accept actions — no trailing newline", () => {
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

describe("accept actions — empty sections", () => {
  test("acceptCurrent with empty current returns empty string for that block", () => {
    const text = ["<<<<<<< HEAD", "=======", "theirs", ">>>>>>> b"].join("\n");
    const block = firstBlock(text);
    const result = acceptCurrent(text, block);
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
