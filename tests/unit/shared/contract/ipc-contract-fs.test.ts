import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

// ---------------------------------------------------------------------------
// fs.call.readdir
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.readdir result", () => {
  const schema = ipcContract.fs.call.readdir.result;

  test("accepts DirEntry with symlink type", () => {
    const result = schema.safeParse([{ name: "link", type: "symlink" }]);
    expect(result.success).toBe(true);
  });

  test("rejects DirEntry with invalid type", () => {
    const result = schema.safeParse([{ name: "foo", type: "unknown" }]);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fs.call.stat
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.stat result", () => {
  const schema = ipcContract.fs.call.stat.result;

  test("rejects FsStat with invalid type", () => {
    const result = schema.safeParse({
      type: "socket",
      size: 0,
      mtime: "2024-06-01T12:00:00.000Z",
      isSymlink: false,
    });
    expect(result.success).toBe(false);
  });

  test("rejects FsStat with negative size", () => {
    const result = schema.safeParse({
      type: "file",
      size: -1,
      mtime: "2024-06-01T12:00:00.000Z",
      isSymlink: false,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fs.call.getExpanded
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.getExpanded result", () => {
  const schema = ipcContract.fs.call.getExpanded.result;

  test("accepts empty relPaths array", () => {
    const result = schema.safeParse({ relPaths: [] });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fs.call.setExpanded
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.setExpanded args", () => {
  const schema = ipcContract.fs.call.setExpanded.args;

  test("accepts empty relPaths array", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPaths: [] });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fs.call.readFile
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.readFile args", () => {
  const schema = ipcContract.fs.call.readFile.args;

  test("strips unknown extra properties", () => {
    const result = schema.safeParse({
      workspaceId: VALID_UUID,
      relPath: "src/index.ts",
      extra: "should-be-stripped",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extra).toBeUndefined();
    }
  });
});

describe("ipcContract.fs.call.readFile result", () => {
  const schema = ipcContract.fs.call.readFile.result;

  const SAMPLE_MTIME = "2025-01-01T00:00:00.000Z";

  test("accepts valid ok result with utf8-bom encoding", () => {
    const result = schema.safeParse({
      kind: "ok",
      content: "hello world",
      encoding: "utf8-bom",
      sizeBytes: 14,
      isBinary: false,
      mtime: SAMPLE_MTIME,
    });
    expect(result.success).toBe(true);
  });

  test("accepts missing result with not-found reason", () => {
    const result = schema.safeParse({ kind: "missing", reason: "not-found" });
    expect(result.success).toBe(true);
  });

  test("rejects ok result with invalid encoding value", () => {
    const result = schema.safeParse({
      kind: "ok",
      content: "",
      encoding: "utf16",
      sizeBytes: 0,
      isBinary: true,
      mtime: SAMPLE_MTIME,
    });
    expect(result.success).toBe(false);
  });

  test("rejects ok result with negative sizeBytes", () => {
    const result = schema.safeParse({
      kind: "ok",
      content: "",
      encoding: "utf8",
      sizeBytes: -1,
      isBinary: false,
      mtime: SAMPLE_MTIME,
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing result with invalid reason", () => {
    const result = schema.safeParse({ kind: "missing", reason: "invalid-reason" });
    expect(result.success).toBe(false);
  });
});
