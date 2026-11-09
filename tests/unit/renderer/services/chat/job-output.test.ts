/**
 * The end of a background job's output, as the side panel shows it: the
 * last lines of the file the CLI writes, read through the workspace, as a
 * terminal would leave them.
 */

import { describe, expect, it } from "bun:test";
import {
  outputReadPath,
  type RangeRead,
  readJobOutput,
  TAIL_BYTES,
  tailOf,
} from "../../../../../src/renderer/services/chat/job-output";

const ESC = String.fromCharCode(0x1b);

describe("tailOf", () => {
  it("keeps every line of a file read whole, without the last newline", () => {
    expect(tailOf("one\ntwo\n", true)).toEqual({ lines: ["one", "two"], cut: false });
  });

  it("drops the first line of a read begun inside the file, which the read cut", () => {
    expect(tailOf("ne\ntwo\nthree", false)).toEqual({ lines: ["two", "three"], cut: true });
  });

  it("keeps only the last lines", () => {
    expect(tailOf("1\n2\n3\n4\n5", true, 2)).toEqual({ lines: ["4", "5"], cut: true });
  });

  it("shows what a terminal would: no colours, a redrawn line in its last state", () => {
    expect(tailOf(`${ESC}[32mok${ESC}[0m\n10%\r50%\r100%\n`, true).lines).toEqual(["ok", "100%"]);
  });
});

describe("outputReadPath", () => {
  it("reads a file under the workspace by its path in it, and one outside by its own", () => {
    expect(outputReadPath("/w/logs/b1.output", "/w")).toBe("logs/b1.output");
    expect(outputReadPath("/tmp/claude/tasks/b1.output", "/w")).toBe("/tmp/claude/tasks/b1.output");
    expect(outputReadPath("tasks/b1.output", "/w")).toBeNull();
  });

  it("reads a Windows file outside the workspace by its path from the drive", () => {
    const output = String.raw`C:\Users\u\AppData\Local\Temp\claude\s\tasks\b1.output`;
    expect(outputReadPath(output, String.raw`C:\w`)).toBe(output);
    expect(outputReadPath("C:/w/logs/b1.output", String.raw`C:\w`)).toBe("logs/b1.output");
    expect(outputReadPath(String.raw`tasks\b1.output`, String.raw`C:\w`)).toBeNull();
  });
});

/** A file of `text` the workspace reads, with the reads it was asked for. */
function file(text: string | null) {
  const bytes = text === null ? null : new TextEncoder().encode(text);
  const asked: [string, number, number][] = [];
  const read: RangeRead = async (_workspaceId, relPath, offset, length) => {
    asked.push([relPath, offset, length]);
    if (!bytes) return null;
    const part = bytes.slice(offset, offset + length);
    return { base64: Buffer.from(part).toString("base64"), sizeBytes: bytes.length };
  };
  return { read, asked };
}

describe("readJobOutput", () => {
  const path = "/tmp/claude/tasks/b1.output";

  it("reads a small file whole", async () => {
    const { read, asked } = file("tick 1\ntick 2\n");
    expect(await readJobOutput("w", "/w", path, read)).toEqual({
      lines: ["tick 1", "tick 2"],
      cut: false,
      sizeBytes: 14,
    });
    expect(asked).toEqual([
      [path, 0, 0],
      [path, 0, 14],
    ]);
  });

  it("reads only the end of a large file", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    const { read, asked } = file(text);
    const output = await readJobOutput("w", "/w", path, read);
    expect(output?.cut).toBe(true);
    expect(output?.lines.at(-1)).toBe("line 5000");
    expect(asked[1]).toEqual([path, text.length - TAIL_BYTES, TAIL_BYTES]);
  });

  it("says an empty file has nothing yet, with no second read", async () => {
    const { read, asked } = file("");
    expect(await readJobOutput("w", "/w", path, read)).toEqual({
      lines: [],
      cut: false,
      sizeBytes: 0,
    });
    expect(asked).toHaveLength(1);
  });

  it("is null for a file it cannot read", async () => {
    expect(await readJobOutput("w", "/w", path, file(null).read)).toBeNull();
    expect(await readJobOutput("w", "/w", "relative.output", file("x").read)).toBeNull();
  });
});
