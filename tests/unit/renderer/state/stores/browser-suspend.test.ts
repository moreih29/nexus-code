/**
 * Unit tests for `useBrowserSuspendStore` and the `useBrowserSuspendWhile` hook.
 *
 * The store gates renderer-side overlay visibility for embedded browser tabs.
 * Two invariants matter:
 *
 *   1. Edge transitions trigger IPC exactly once.
 *      - 0 → 1 → `browser.suspendAll`
 *      - 1 → 0 → `browser.resumeAll`
 *      - Intermediate transitions (1 → 2, 2 → 1) MUST NOT call IPC.
 *
 *   2. The returned `release` callback is idempotent — calling it twice does
 *      not decrement the counter twice (React 18 StrictMode runs effect
 *      cleanup twice in development, so a non-idempotent release would corrupt
 *      the count and leak claims).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock ipcCallResult so we can assert IPC call shape without booting the
// renderer's preload bridge.
// ---------------------------------------------------------------------------

const ipcCalls: Array<{ channel: string; method: string; args: unknown }> = [];

// IMPORTANT: `mock.module` is process-global, so other tests in the same Bun
// run see this surrogate module and would crash on any missing export they
// happen to import.  Spread the real module so every name remains available;
// only override `ipcCallResult` for the assertion we care about.
const realIpcClient = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCallResult: mock(async (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    return { ok: true as const, value: undefined };
  }),
}));

// Import after mock so the store binds to the mocked ipcCallResult.
const { useBrowserSuspendStore } = await import(
  "../../../../../src/renderer/state/stores/browser-suspend"
);

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

function resetStore(): void {
  // Force the counter back to 0 between tests so each case starts fresh.
  // We do this by directly setting the count via the store internals.
  useBrowserSuspendStore.setState({ count: 0 });
  ipcCalls.length = 0;
}

describe("useBrowserSuspendStore.claim()", () => {
  beforeEach(resetStore);

  // -------------------------------------------------------------------------
  // 1. 0 → 1 fires suspendAll, 1 → 0 fires resumeAll
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // 2. Intermediate transitions are silent
  // -------------------------------------------------------------------------

  test("overlapping claims fire suspendAll only on the first; second claim is silent", () => {
    const release1 = useBrowserSuspendStore.getState().claim();
    const release2 = useBrowserSuspendStore.getState().claim();
    expect(useBrowserSuspendStore.getState().count).toBe(2);
    // Only the first claim should have fired IPC.
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: true } },
    ]);

    // Releasing one of two does NOT fire resumeAll — content stays suspended.
    release1();
    expect(useBrowserSuspendStore.getState().count).toBe(1);
    expect(ipcCalls.length).toBe(1);

    // Releasing the last one triggers resumeAll exactly once.
    release2();
    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: true } },
      { channel: "browser", method: "resumeAll", args: {} },
    ]);
  });

  // -------------------------------------------------------------------------
  // 3. Idempotent release — React 18 StrictMode safety
  // -------------------------------------------------------------------------

  test("calling release() twice does NOT double-decrement the counter", () => {
    const releaseA = useBrowserSuspendStore.getState().claim();
    const releaseB = useBrowserSuspendStore.getState().claim();
    expect(useBrowserSuspendStore.getState().count).toBe(2);

    releaseA();
    releaseA(); // second call must be a no-op
    expect(useBrowserSuspendStore.getState().count).toBe(1);

    releaseB();
    expect(useBrowserSuspendStore.getState().count).toBe(0);
    // resumeAll fired exactly once — not twice.
    expect(ipcCalls.filter((c) => c.method === "resumeAll").length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. Defensive clamp — over-release never drives count negative
  // -------------------------------------------------------------------------

  test("releasing more times than claimed cannot drive count below 0", () => {
    const release = useBrowserSuspendStore.getState().claim();
    release();
    // A different over-release path: a fresh release fn that wasn't claimed.
    // Synthesise it by invoking claim+release first then attempting a new
    // bogus release scenario.  Since release is idempotent, recreate a fresh
    // claim, save its release, release the *previous* one again (no-op), then
    // release the new one.
    const release2 = useBrowserSuspendStore.getState().claim();
    release(); // already released — no-op
    release2();

    expect(useBrowserSuspendStore.getState().count).toBe(0);
  });
});
