/** Contract: ipcContract.hello */
import { describe, expect, test } from "bun:test";
import { ipcContract } from "../../../../src/shared/ipc-contract";

describe("ipcContract.hello.call.ping", () => {
  test("result accepts 'pong'", () => {
    const result = ipcContract.hello.call.ping.result.safeParse("pong");
    expect(result.success).toBe(true);
  });

  test("result rejects other strings", () => {
    const result = ipcContract.hello.call.ping.result.safeParse("hello");
    expect(result.success).toBe(false);
  });

  test("result rejects non-string", () => {
    const result = ipcContract.hello.call.ping.result.safeParse(42);
    expect(result.success).toBe(false);
  });
});

describe("ipcContract.hello.listen.tick", () => {
  const schema = ipcContract.hello.listen.tick.args;

  test("accepts a number", () => {
    const result = schema.safeParse(1);
    expect(result.success).toBe(true);
  });

  test("rejects a string", () => {
    const result = schema.safeParse("not-a-number");
    expect(result.success).toBe(false);
  });
});
