/** Contract: ipcContract.dialog */
import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

describe("ipcContract.dialog.call.showOpenFile", () => {
  const schema = ipcContract.dialog.call.showOpenFile.args;

  test("accepts empty args (all optional)", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts full args with filters", () => {
    const result = schema.safeParse({
      title: "Open File",
      defaultPath: "/home/user",
      filters: [{ name: "TypeScript", extensions: ["ts", "tsx"] }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects filters with missing extensions", () => {
    const result = schema.safeParse({ filters: [{ name: "TS" }] });
    expect(result.success).toBe(false);
  });

  test("result accepts canceled response", () => {
    const result = ipcContract.dialog.call.showOpenFile.result.safeParse({
      canceled: true,
      filePaths: [],
    });
    expect(result.success).toBe(true);
  });

  test("result accepts selected files", () => {
    const result = ipcContract.dialog.call.showOpenFile.result.safeParse({
      canceled: false,
      filePaths: ["/home/user/file.ts"],
    });
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.dialog.call.showOpenDirectory", () => {
  const schema = ipcContract.dialog.call.showOpenDirectory.args;

  test("accepts empty args", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts title and defaultPath", () => {
    const result = schema.safeParse({ title: "Select Folder", defaultPath: "/home/user" });
    expect(result.success).toBe(true);
  });

  test("result rejects missing canceled field", () => {
    const result = ipcContract.dialog.call.showOpenDirectory.result.safeParse({
      filePaths: ["/home/user/dir"],
    });
    expect(result.success).toBe(false);
  });
});
