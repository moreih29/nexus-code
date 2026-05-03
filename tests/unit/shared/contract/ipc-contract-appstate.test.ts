import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

describe("ipcContract.appState.call.set", () => {
  const schema = ipcContract.appState.call.set.args;

  test("rejects invalid type for sidebarWidth", () => {
    const result = schema.safeParse({ sidebarWidth: "not-a-number" });
    expect(result.success).toBe(false);
  });

  test("accepts valid sidebarWidth", () => {
    const result = schema.safeParse({ sidebarWidth: 320 });
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.appState.call.get", () => {
  const schema = ipcContract.appState.call.get.result;

  test("result schema accepts empty object (all fields optional)", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.appState.call.set — edge cases", () => {
  const schema = ipcContract.appState.call.set.args;

  test("rejects negative filesPanelWidth", () => {
    const result = schema.safeParse({ filesPanelWidth: -1 });
    expect(result.success).toBe(false);
  });

  test("rejects layoutByWorkspace with non-uuid key", () => {
    const result = schema.safeParse({ layoutByWorkspace: { "not-a-uuid": { root: null } } });
    expect(result.success).toBe(false);
  });
});
