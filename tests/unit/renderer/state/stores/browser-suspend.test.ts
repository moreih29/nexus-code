import { beforeEach, describe, expect, mock, test } from "bun:test";

const ipcCalls: Array<{ channel: string; method: string; args: unknown }> = [];

const realIpcClient = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCallResult: mock(async (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    return { ok: true as const, value: undefined };
  }),
}));

const { useBrowserSuspendStore } = await import(
  "../../../../../src/renderer/state/stores/browser-suspend"
);

function resetStore(): void {
  useBrowserSuspendStore.setState({ count: 0 });
  ipcCalls.length = 0;
}

describe("useBrowserSuspendStore.claim()", () => {
  beforeEach(resetStore);

  test("first claim fires browser.suspendAll; matching release fires browser.resumeAll", () => {
    const release = useBrowserSuspendStore.getState().claim();
    expect(useBrowserSuspendStore.getState().count).toBe(1);
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: true } },
    ]);

    release();
    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: true } },
      { channel: "browser", method: "resumeAll", args: {} },
    ]);
  });

  test("overlapping claims fire suspendAll only on the first; second claim is silent", () => {
    const release1 = useBrowserSuspendStore.getState().claim();
    const release2 = useBrowserSuspendStore.getState().claim();
    expect(useBrowserSuspendStore.getState().count).toBe(2);
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: true } },
    ]);

    release1();
    expect(useBrowserSuspendStore.getState().count).toBe(1);
    expect(ipcCalls.length).toBe(1);

    release2();
    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: true } },
      { channel: "browser", method: "resumeAll", args: {} },
    ]);
  });

  test("calling release() twice does NOT double-decrement the counter", () => {
    const releaseA = useBrowserSuspendStore.getState().claim();
    const releaseB = useBrowserSuspendStore.getState().claim();
    expect(useBrowserSuspendStore.getState().count).toBe(2);

    releaseA();
    releaseA();
    expect(useBrowserSuspendStore.getState().count).toBe(1);

    releaseB();
    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls.filter((c) => c.method === "resumeAll").length).toBe(1);
  });

  test("releasing more times than claimed cannot drive count below 0", () => {
    const release = useBrowserSuspendStore.getState().claim();
    release();
    const release2 = useBrowserSuspendStore.getState().claim();
    release();
    release2();

    expect(useBrowserSuspendStore.getState().count).toBe(0);
  });
});
