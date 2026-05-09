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
