import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../src/shared/ipc-contract";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

// ---------------------------------------------------------------------------
// fs.call.readdir
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.readdir args", () => {
  const schema = ipcContract.fs.call.readdir.args;

  test("accepts valid args with empty relPath", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPath: "" });
    expect(result.success).toBe(true);
  });

  test("accepts valid args with '.' relPath", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPath: "." });
    expect(result.success).toBe(true);
  });

  test("accepts valid args with nested relPath", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPath: "src/components" });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid workspaceId", () => {
    const result = schema.safeParse({ workspaceId: "not-a-uuid", relPath: "src" });
    expect(result.success).toBe(false);
  });

  test("rejects missing workspaceId", () => {
    const result = schema.safeParse({ relPath: "src" });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.fs.call.readdir result", () => {
  const schema = ipcContract.fs.call.readdir.result;

  test("accepts valid DirEntry array", () => {
    const result = schema.safeParse([
      { name: "index.ts", type: "file", size: 1024, mtime: "2024-01-01T00:00:00.000Z" },
      { name: "components", type: "dir" },
    ]);
    expect(result.success).toBe(true);
  });

  test("accepts DirEntry with symlink type", () => {
    const result = schema.safeParse([{ name: "link", type: "symlink" }]);
    expect(result.success).toBe(true);
  });

  test("rejects DirEntry with invalid type", () => {
    const result = schema.safeParse([{ name: "foo", type: "unknown" }]);
    expect(result.success).toBe(false);
  });

  test("rejects DirEntry missing name", () => {
    const result = schema.safeParse([{ type: "file" }]);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fs.call.stat
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.stat args", () => {
  const schema = ipcContract.fs.call.stat.args;

  test("accepts valid args", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPath: "src/index.ts" });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid workspaceId", () => {
    const result = schema.safeParse({ workspaceId: "bad-id", relPath: "src" });
    expect(result.success).toBe(false);
  });

  test("rejects missing relPath", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fs.call.watch
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.watch args", () => {
  const schema = ipcContract.fs.call.watch.args;

  test("accepts valid args with empty relPath (root)", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPath: "" });
    expect(result.success).toBe(true);
  });

  test("accepts valid args with nested relPath", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPath: "src/components" });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid workspaceId", () => {
    const result = schema.safeParse({ workspaceId: "not-a-uuid", relPath: "src" });
    expect(result.success).toBe(false);
  });

  test("rejects missing relPath", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fs.call.unwatch
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.unwatch args", () => {
  const schema = ipcContract.fs.call.unwatch.args;

  test("accepts valid args with nested relPath", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPath: "src" });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid workspaceId", () => {
    const result = schema.safeParse({ workspaceId: "bad-id", relPath: "src" });
    expect(result.success).toBe(false);
  });

  test("rejects missing workspaceId", () => {
    const result = schema.safeParse({ relPath: "src" });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.fs.call.stat result", () => {
  const schema = ipcContract.fs.call.stat.result;

  test("accepts valid FsStat", () => {
    const result = schema.safeParse({
      type: "file",
      size: 2048,
      mtime: "2024-06-01T12:00:00.000Z",
      isSymlink: false,
    });
    expect(result.success).toBe(true);
  });

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

  test("rejects FsStat missing isSymlink", () => {
    const result = schema.safeParse({
      type: "file",
      size: 100,
      mtime: "2024-06-01T12:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fs.call.getExpanded
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.getExpanded args", () => {
  const schema = ipcContract.fs.call.getExpanded.args;

  test("accepts valid workspaceId", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid workspaceId", () => {
    const result = schema.safeParse({ workspaceId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  test("rejects missing workspaceId", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.fs.call.getExpanded result", () => {
  const schema = ipcContract.fs.call.getExpanded.result;

  test("accepts valid relPaths array", () => {
    const result = schema.safeParse({ relPaths: ["src", "src/components"] });
    expect(result.success).toBe(true);
  });

  test("accepts empty relPaths array", () => {
    const result = schema.safeParse({ relPaths: [] });
    expect(result.success).toBe(true);
  });

  test("rejects missing relPaths", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fs.call.setExpanded
// ---------------------------------------------------------------------------

describe("ipcContract.fs.call.setExpanded args", () => {
  const schema = ipcContract.fs.call.setExpanded.args;

  test("accepts valid workspaceId and relPaths array", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPaths: ["src"] });
    expect(result.success).toBe(true);
  });

  test("accepts empty relPaths array", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, relPaths: [] });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid workspaceId", () => {
    const result = schema.safeParse({ workspaceId: "bad-id", relPaths: [] });
    expect(result.success).toBe(false);
  });

  test("rejects missing relPaths", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID });
    expect(result.success).toBe(false);
  });
});
