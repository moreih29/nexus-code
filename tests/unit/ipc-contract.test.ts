import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { type InferArgs, type InferReturn, ipcContract } from "../../src/shared/ipc-contract";

const SAMPLE_ROOT = path.join(os.tmpdir(), "projects/foo");

// ---------------------------------------------------------------------------
// Compile-time type assertion helpers
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertType<_T extends true>(): void {}

// ---------------------------------------------------------------------------
// Compile-time: inferArgs for workspace.call.create
// ---------------------------------------------------------------------------

type CreateArgs = InferArgs<typeof ipcContract.workspace.call.create>;
// Must be { rootPath: string; name?: string | undefined }
assertType<Equals<CreateArgs, { rootPath: string; name?: string | undefined }>>();

type CreateReturn = InferReturn<typeof ipcContract.workspace.call.create>;
// Must match WorkspaceMeta shape — spot-check that it has id and rootPath
assertType<CreateReturn extends { id: string; rootPath: string } ? true : false>();

// ---------------------------------------------------------------------------
// Runtime: zod parse workspace.call.create args
// ---------------------------------------------------------------------------

describe("ipcContract.workspace.call.create", () => {
  const schema = ipcContract.workspace.call.create.args;

  test("parses valid args with rootPath only", () => {
    const result = schema.safeParse({ rootPath: SAMPLE_ROOT });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rootPath).toBe(SAMPLE_ROOT);
      expect(result.data.name).toBeUndefined();
    }
  });

  test("parses valid args with rootPath and name", () => {
    const result = schema.safeParse({ rootPath: SAMPLE_ROOT, name: "My Project" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("My Project");
    }
  });

  test("rejects missing rootPath", () => {
    const result = schema.safeParse({ name: "No Path" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runtime: hello.call.ping
// ---------------------------------------------------------------------------

describe("ipcContract.hello.call.ping", () => {
  test("result schema accepts 'pong'", () => {
    const result = ipcContract.hello.call.ping.result.safeParse("pong");
    expect(result.success).toBe(true);
  });

  test("result schema rejects other strings", () => {
    const result = ipcContract.hello.call.ping.result.safeParse("hello");
    expect(result.success).toBe(false);
  });
});
