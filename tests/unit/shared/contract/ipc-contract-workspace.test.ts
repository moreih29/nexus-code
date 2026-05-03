/** Contract: ipcContract.workspace */
import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("ipcContract.workspace.call.list", () => {
  test("args accepts void (undefined)", () => {
    const result = ipcContract.workspace.call.list.args.safeParse(undefined);
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.workspace.call.create", () => {
  const schema = ipcContract.workspace.call.create.args;

  test("accepts rootPath only", () => {
    const result = schema.safeParse({ rootPath: "/home/user/project" });
    expect(result.success).toBe(true);
  });

  test("accepts rootPath and name", () => {
    const result = schema.safeParse({ rootPath: "/home/user/project", name: "My Project" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("My Project");
  });

  test("rejects missing rootPath", () => {
    const result = schema.safeParse({ name: "No Path" });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.workspace.call.update", () => {
  const schema = ipcContract.workspace.call.update.args;

  test("accepts valid pinned update", () => {
    const result = schema.safeParse({ id: VALID_UUID, pinned: true });
    expect(result.success).toBe(true);
  });

  test("accepts valid name update", () => {
    const result = schema.safeParse({ id: VALID_UUID, name: "Renamed" });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid id", () => {
    const result = schema.safeParse({ id: "not-a-uuid", name: "X" });
    expect(result.success).toBe(false);
  });

  test("rejects missing id", () => {
    const result = schema.safeParse({ name: "No ID" });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.workspace.call.remove", () => {
  const schema = ipcContract.workspace.call.remove.args;

  test("accepts valid uuid", () => {
    const result = schema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid id", () => {
    const result = schema.safeParse({ id: "bad-id" });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.workspace.call.activate", () => {
  const schema = ipcContract.workspace.call.activate.args;

  test("accepts valid uuid", () => {
    const result = schema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.workspace.listen.changed", () => {
  const schema = ipcContract.workspace.listen.changed.args;

  test("accepts valid WorkspaceMeta payload", () => {
    const result = schema.safeParse({
      id: VALID_UUID,
      name: "ws",
      rootPath: "/home/user/ws",
      colorTone: "default",
      pinned: false,
      tabs: [],
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing required fields", () => {
    const result = schema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.workspace.listen.removed", () => {
  const schema = ipcContract.workspace.listen.removed.args;

  test("accepts valid uuid payload", () => {
    const result = schema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.workspace.listen.attention", () => {
  const schema = ipcContract.workspace.listen.attention.args;

  test("accepts valid uuid payload", () => {
    const result = schema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(true);
  });
});
