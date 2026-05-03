/** Contract: ipcContract.pty */
import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("ipcContract.pty.call.spawn", () => {
  const schema = ipcContract.pty.call.spawn.args;

  test("accepts valid spawn args", () => {
    const result = schema.safeParse({ tabId: VALID_UUID, cwd: "/home/user", cols: 80, rows: 24 });
    expect(result.success).toBe(true);
  });

  test("accepts optional env", () => {
    const result = schema.safeParse({
      tabId: VALID_UUID,
      cwd: "/tmp",
      cols: 120,
      rows: 40,
      env: { TERM: "xterm-256color" },
    });
    expect(result.success).toBe(true);
  });

  test("rejects non-positive cols", () => {
    const result = schema.safeParse({ tabId: VALID_UUID, cwd: "/tmp", cols: 0, rows: 24 });
    expect(result.success).toBe(false);
  });

  test("rejects non-uuid tabId", () => {
    const result = schema.safeParse({ tabId: "bad", cwd: "/tmp", cols: 80, rows: 24 });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.pty.call.write", () => {
  const schema = ipcContract.pty.call.write.args;

  test("accepts valid write args", () => {
    const result = schema.safeParse({ tabId: VALID_UUID, data: "ls\n" });
    expect(result.success).toBe(true);
  });

  test("rejects missing data", () => {
    const result = schema.safeParse({ tabId: VALID_UUID });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.pty.call.resize", () => {
  const schema = ipcContract.pty.call.resize.args;

  test("accepts valid resize args", () => {
    const result = schema.safeParse({ tabId: VALID_UUID, cols: 100, rows: 30 });
    expect(result.success).toBe(true);
  });

  test("rejects negative rows", () => {
    const result = schema.safeParse({ tabId: VALID_UUID, cols: 80, rows: -1 });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.pty.call.kill", () => {
  const schema = ipcContract.pty.call.kill.args;

  test("accepts valid uuid", () => {
    const result = schema.safeParse({ tabId: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects non-uuid tabId", () => {
    const result = schema.safeParse({ tabId: "bad" });
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.pty.listen.data", () => {
  const schema = ipcContract.pty.listen.data.args;

  test("accepts valid data event", () => {
    const result = schema.safeParse({ tabId: VALID_UUID, chunk: "\x1b[32mOK\x1b[0m" });
    expect(result.success).toBe(true);
  });
});

describe("ipcContract.pty.listen.exit", () => {
  const schema = ipcContract.pty.listen.exit.args;

  test("accepts exit code 0", () => {
    const result = schema.safeParse({ tabId: VALID_UUID, code: 0 });
    expect(result.success).toBe(true);
  });

  test("accepts null exit code (signal kill)", () => {
    const result = schema.safeParse({ tabId: VALID_UUID, code: null });
    expect(result.success).toBe(true);
  });

  test("rejects string code", () => {
    const result = schema.safeParse({ tabId: VALID_UUID, code: "0" });
    expect(result.success).toBe(false);
  });
});
