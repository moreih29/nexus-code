/**
 * Terminal input reaches the PTY in the order it was typed: one write per
 * session is in flight at a time, since the agent may run two writes sent
 * back to back in either order.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

interface WriteCall {
  readonly tabId: string;
  readonly data: string;
  settle(fail?: boolean): void;
}

const writes: WriteCall[] = [];

mock.module("../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: mock((_channel: string, method: string, args: { tabId: string; data: string }) => {
    if (method !== "write") return Promise.resolve({ ok: true as const, value: undefined });
    return new Promise((resolve, reject) => {
      writes.push({
        tabId: args.tabId,
        data: args.data,
        settle: (fail) =>
          fail ? reject(new Error("agent gone")) : resolve({ ok: true, value: undefined }),
      });
    });
  }),
  ipcListen: () => () => {},
  unwrapIpcResult: (result: { value: unknown }) => result.value,
}));

const { writeSession } = await import("../../../../src/renderer/services/terminal/pty-client");

/** Lets the settled write's continuation run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  writes.length = 0;
});

describe("writeSession", () => {
  it("sends input that arrives during a write after it, in one write", async () => {
    writeSession("ws", "tab-a", "한");
    writeSession("ws", "tab-a", "\r");
    writeSession("ws", "tab-a", "ls");
    expect(writes.map((w) => w.data)).toEqual(["한"]);

    writes[0].settle();
    await flush();
    expect(writes.map((w) => w.data)).toEqual(["한", "\rls"]);

    writes[1].settle();
    await flush();
    writeSession("ws", "tab-a", "x");
    expect(writes.map((w) => w.data)).toEqual(["한", "\rls", "x"]);
    writes[2].settle();
  });

  it("does not hold one session's input behind another's", () => {
    writeSession("ws", "tab-b", "a");
    writeSession("ws", "tab-c", "b");
    expect(writes.map((w) => [w.tabId, w.data])).toEqual([
      ["tab-b", "a"],
      ["tab-c", "b"],
    ]);
    for (const write of writes) write.settle();
  });

  it("sends the input after a write that failed", async () => {
    writeSession("ws", "tab-d", "a");
    writeSession("ws", "tab-d", "b");
    writes[0].settle(true);
    await flush();
    expect(writes.map((w) => w.data)).toEqual(["a", "b"]);
    writes[1].settle();
  });
});
