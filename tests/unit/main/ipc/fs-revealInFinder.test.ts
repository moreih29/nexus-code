/**
 * Tests for the fs.revealInFinder IPC channel.
 *
 * move-handlers.ts imports Electron's `shell` at module-evaluation time,
 * which prevents importing it under Bun's test runtime when other tests in
 * the same worker have already mocked `electron` with a different shape
 * (the same constraint that governs the existing fs-channel.test.ts — see
 * the NOTE comment in src/main/ipc/channels/fs/index.ts).
 *
 * We therefore test only the IPC contract layer (Zod schema validation)
 * here; the shell dispatch is covered by the contract test and by manual
 * QA in the running app.
 */

import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

const schema = ipcContract.fs.call.revealInFinder.args;

describe("ipcContract.fs.call.revealInFinder args", () => {
  test("accepts an absolute path", () => {
    const result = schema.safeParse({ absolutePath: "/Users/alice/projects/lib/types.ts" });
    expect(result.success).toBe(true);
  });

  test("accepts any non-empty string path", () => {
    const result = schema.safeParse({ absolutePath: "/tmp/foo.txt" });
    expect(result.success).toBe(true);
  });

  test("rejects missing absolutePath", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects null absolutePath", () => {
    const result = schema.safeParse({ absolutePath: null });
    expect(result.success).toBe(false);
  });

  test("rejects non-string absolutePath", () => {
    const result = schema.safeParse({ absolutePath: 42 });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.fs.call.revealInFinder result", () => {
  test("result schema is void (undefined)", () => {
    const result = ipcContract.fs.call.revealInFinder.result.safeParse(undefined);
    expect(result.success).toBe(true);
  });
});
