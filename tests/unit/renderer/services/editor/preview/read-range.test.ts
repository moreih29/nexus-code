// Reading a workspace file a part at a time over fs.readRange.

import { afterEach, describe, expect, test } from "bun:test";
import {
  type FilePart,
  readRange,
} from "../../../../../../src/renderer/services/editor/preview/read-range";
import { READ_RANGE_MAX_BYTES } from "../../../../../../src/shared/fs/defaults";

const PIECE = READ_RANGE_MAX_BYTES;
const SIZE = PIECE * 6 + 3;
const file = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) file[i] = i % 253;

let mtimeAt: (offset: number) => string = () => "t1";
let missing = false;
const reads: Array<{ offset: number; length: number }> = [];

/** fs.readRange over `file`: at most one piece, with the file's size. */
async function read(offset: number, length: number): Promise<FilePart | null> {
  reads.push({ offset, length });
  if (missing) return null;
  return {
    bytes: file.subarray(offset, offset + Math.min(length, PIECE)),
    size: SIZE,
    mtime: mtimeAt(offset),
  };
}

const readWorkspaceRange = (
  _ws: string,
  _path: string,
  offset: number,
  length: number,
  mtime?: string,
) => readRange(read, offset, length, mtime);

afterEach(() => {
  reads.length = 0;
  mtimeAt = () => "t1";
  missing = false;
});

describe("readRange", () => {
  test("reads a part within one read in one call, with the file's size", async () => {
    const part = await readWorkspaceRange("ws", "doc.pdf", 10, 20);
    expect(part).toEqual({ bytes: file.subarray(10, 30), size: SIZE, mtime: "t1" });
    expect(reads).toEqual([{ offset: 10, length: 20 }]);
  });

  test("reads a larger part in pieces of one read each, and joins them", async () => {
    const from = PIECE - 5;
    const length = PIECE * 5 + 7;
    const part = await readWorkspaceRange("ws", "doc.pdf", from, length);
    expect(part?.bytes).toEqual(file.subarray(from, from + length));
    expect(reads.map((r) => r.offset)).toEqual([0, 1, 2, 3, 4, 5].map((i) => from + i * PIECE));
    expect(reads.at(-1)?.length).toBe(7);
  });

  test("is cut short at the end of the file", async () => {
    const part = await readWorkspaceRange("ws", "doc.pdf", SIZE - 2, 100);
    expect(part?.bytes).toEqual(file.subarray(SIZE - 2));
  });

  test("is null for a missing file, or one changed from what it was", async () => {
    missing = true;
    expect(await readWorkspaceRange("ws", "doc.pdf", 0, 10)).toBeNull();
    missing = false;

    expect(await readWorkspaceRange("ws", "doc.pdf", 0, 10, "t0")).toBeNull();
    mtimeAt = (offset) => (offset >= PIECE * 2 ? "t2" : "t1");
    expect(await readWorkspaceRange("ws", "doc.pdf", 0, PIECE * 3)).toBeNull();
  });
});
