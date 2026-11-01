/**
 * Ignored-path cache — answers that were in flight when the cache was
 * cleared (a `.gitignore` edit) must not land in the fresh cache.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";

const WS = "00000000-0000-0000-0000-0000000000aa";
/** Past the store's 250 ms flush debounce; the clock is fake. */
const FLUSH_WAIT_MS = 300;

interface PendingCall {
  relPaths: string[];
  answer: (ignored: string[]) => void;
}

const calls: PendingCall[] = [];

const CLIENT = "../../../../../src/renderer/ipc/client";

// Other files mock the IPC client process-wide, so this file installs its
// own and puts back whatever it found when it is done.
const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  canUseIpcBridge: () => true,
  ipcCallResult: (
    _channel: string,
    _method: string,
    args: { workspaceId: string; relPaths: string[] },
  ) =>
    // A flush another file scheduled can still fire here; answer it and keep
    // it out of `calls`.
    args.workspaceId !== WS
      ? Promise.resolve({ ok: true, value: { ignored: [] } })
      : new Promise((resolve) => {
          calls.push({
            relPaths: args.relPaths,
            answer: (ignored) => resolve({ ok: true, value: { ignored } }),
          });
        }),
  mustSucceed: (result: { ok: true; value: unknown }) => result.value,
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { useIgnoredStore } = await import("../../../../../src/renderer/state/stores/git/ignored");

/** Lets an answered check reach the cache. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  useIgnoredStore.setState({ byWorkspace: new Map() });
});

afterEach(() => {
  useIgnoredStore.getState().clearWorkspace(WS);
  jest.useRealTimers();
});

describe("ignored cache", () => {
  it("drops answers that were in flight when the cache was cleared", async () => {
    const store = useIgnoredStore.getState();
    store.enqueueCheck(WS, "/repo/dist/a.js", "dist/a.js");
    store.enqueueCheck(WS, "/repo/dist/b.js", "dist/b.js");
    jest.advanceTimersByTime(FLUSH_WAIT_MS);
    expect(calls).toHaveLength(1);

    // `.gitignore` gains `dist/` while git is still answering the old batch.
    store.clearWorkspace(WS);
    store.enqueueCheck(WS, "/repo/dist/a.js", "dist/a.js");
    calls[0]?.answer([]);
    await settle();

    // b.js was not re-queued yet; the stale "not ignored" must not stick.
    expect(store.isIgnored(WS, "/repo/dist/b.js")).toBeUndefined();

    jest.advanceTimersByTime(FLUSH_WAIT_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.relPaths).toEqual(["dist/a.js"]);
    calls[1]?.answer(["dist/a.js"]);
    await settle();
    expect(store.isIgnored(WS, "/repo/dist/a.js")).toBe(true);
  });

  it("keeps answers when the cache was not cleared", async () => {
    const store = useIgnoredStore.getState();
    store.enqueueCheck(WS, "/repo/dist/a.js", "dist/a.js");
    jest.advanceTimersByTime(FLUSH_WAIT_MS);
    calls[0]?.answer(["dist/a.js"]);
    await settle();
    expect(store.isIgnored(WS, "/repo/dist/a.js")).toBe(true);
  });
});
