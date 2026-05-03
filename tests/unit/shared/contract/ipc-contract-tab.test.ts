/** Contract: ipcContract.tab */
import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("ipcContract.tab.call.create", () => {
  const schema = ipcContract.tab.call.create.args;

  test("accepts valid terminal tab args", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, type: "terminal" });
    expect(result.success).toBe(true);
  });

  test("accepts valid editor tab with optional fields", () => {
    const result = schema.safeParse({
      workspaceId: VALID_UUID,
      type: "editor",
      title: "My File",
      cwd: "/home/user",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid tab type", () => {
    const result = schema.safeParse({ workspaceId: VALID_UUID, type: "unknown" });
    expect(result.success).toBe(false);
  });

  test("rejects non-uuid workspaceId", () => {
    const result = schema.safeParse({ workspaceId: "bad-id", type: "terminal" });
    expect(result.success).toBe(false);
  });

  test("rejects missing workspaceId", () => {
    const result = schema.safeParse({ type: "terminal" });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.tab.call.close", () => {
  const schema = ipcContract.tab.call.close.args;

  test("accepts valid uuid", () => {
    const result = schema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid id", () => {
    const result = schema.safeParse({ id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.tab.call.switch", () => {
  const schema = ipcContract.tab.call.switch.args;

  test("accepts valid uuid", () => {
    const result = schema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });
});
