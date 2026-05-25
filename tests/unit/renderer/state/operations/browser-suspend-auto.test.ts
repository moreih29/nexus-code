/**
 * Unit tests for `initBrowserOverlayAutoSuspend`.
 *
 * Verifies that the MutationObserver-based auto-suspend:
 *   1. Claims a suspend slot when a Radix overlay appears in the DOM.
 *   2. Releases when the last overlay disappears.
 *   3. Coalesces multiple mutations in a single tick into one querySelector
 *      cycle (no thrashing on Radix portal subtree mounts).
 *   4. Is idempotent — a second `init…` call is a silent no-op.
 *   5. Recognises every Radix portal shape we ship with (dialog, alertdialog,
 *      menu, popper-content-wrapper).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the IPC client.  The suspend store fires IPC on edge transitions; the
// mock captures the call sequence for the assertions below.
// ---------------------------------------------------------------------------

const ipcCalls: Array<{ channel: string; method: string; args: unknown }> = [];

const realIpcClient = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCallResult: mock(async (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    return { ok: true as const, value: undefined };
  }),
}));

// ---------------------------------------------------------------------------
// Minimal DOM stubs — bun:test has no jsdom by default.  We need a body that
// supports querySelector, a MutationObserver that fires when mutate() is
// called, and a way to add/remove "overlay" stand-in nodes.
// ---------------------------------------------------------------------------

class FakeBody {
  children: Array<{ getAttribute(name: string): string | null; matches(sel: string): boolean }> = [];
  // Observers attached to this body — invoked whenever mutate() runs.
  observers: Array<() => void> = [];

  addChild(attrs: Record<string, string>): { _attrs: Record<string, string> } {
    const node = {
      _attrs: { ...attrs },
      getAttribute(name: string): string | null {
        return node._attrs[name] ?? null;
      },
      matches(sel: string): boolean {
        // Coarse: split the selector by comma and check each fragment.
        return sel.split(",").some((part) => {
          const trimmed = part.trim();
          // [foo="bar"]
          const attrMatch = trimmed.match(/^\[([a-z-]+)="([^"]+)"\]$/);
          if (attrMatch) {
            return node._attrs[attrMatch[1]] === attrMatch[2];
          }
          // [foo]
          const flagMatch = trimmed.match(/^\[([a-z-]+)\]$/);
          if (flagMatch) {
            return flagMatch[1] in node._attrs;
          }
          return false;
        });
      },
    };
    this.children.push(node);
    this.notify();
    return node;
  }

  removeChild(node: unknown): void {
    this.children = this.children.filter((c) => c !== node);
    this.notify();
  }

  querySelector(sel: string): unknown {
    for (const child of this.children) {
      if (child.matches(sel)) return child;
    }
    return null;
  }

  notify(): void {
    for (const cb of this.observers) cb();
  }
}

class FakeMutationObserver {
  constructor(private cb: () => void) {}
  observe(target: { observers: Array<() => void> }): void {
    target.observers.push(this.cb);
  }
  disconnect(): void {
    /* not exercised */
  }
}

const fakeBody = new FakeBody();
(globalThis as Record<string, unknown>).document = {
  body: fakeBody,
  // `document.querySelector` in the implementation walks the whole document
  // tree.  In our fake world that tree contains only `body`, so we delegate
  // to it directly.
  querySelector(sel: string): unknown {
    return fakeBody.querySelector(sel);
  },
};
(globalThis as Record<string, unknown>).MutationObserver = FakeMutationObserver;
// queueMicrotask is part of the standard global in bun, but make it explicit
// here so the test setup mirrors the production runtime exactly.
if (typeof (globalThis as Record<string, unknown>).queueMicrotask !== "function") {
  (globalThis as Record<string, unknown>).queueMicrotask = (cb: () => void) => {
    void Promise.resolve().then(cb);
  };
}

// Import after the globals + mocks are in place.
const { initBrowserOverlayAutoSuspend } = await import(
  "../../../../../src/renderer/state/operations/browser-suspend-auto"
);
const { useBrowserSuspendStore } = await import(
  "../../../../../src/renderer/state/stores/browser-suspend"
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Wait one microtask so the observer's `queueMicrotask(check)` runs. */
async function tick(): Promise<void> {
  await Promise.resolve();
}

function resetWorld(): void {
  // Drop any test fixtures from the previous run.  Do NOT touch
  // `fakeBody.observers` — the production observer is install-once and
  // tearing it down between tests would silently disable the observer for
  // every subsequent case.
  fakeBody.children.length = 0;
  ipcCalls.length = 0;
  useBrowserSuspendStore.setState({ count: 0 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initBrowserOverlayAutoSuspend", () => {
  // Install once before the suite — production runs install during bootstrap.
  initBrowserOverlayAutoSuspend();

  beforeEach(resetWorld);
  afterEach(() => {
    // Make sure each test leaves the suspend store at 0 — guards against a
    // forgotten overlay leaking into the next test.
    if (fakeBody.children.length > 0) {
      fakeBody.children.length = 0;
      fakeBody.notify();
    }
  });

  // -------------------------------------------------------------------------
  // 1. Claim on overlay mount, release on overlay unmount
  // -------------------------------------------------------------------------

  test("claims on first overlay mount; releases when last overlay unmounts", async () => {
    expect(useBrowserSuspendStore.getState().count).toBe(0);

    const dialog = fakeBody.addChild({ role: "dialog" });
    await tick();
    expect(useBrowserSuspendStore.getState().count).toBe(1);
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: true } },
    ]);

    fakeBody.removeChild(dialog);
    await tick();
    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls.filter((c) => c.method === "resumeAll").length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Multiple overlays — single claim across the whole stack
  // -------------------------------------------------------------------------

  test("stacked overlays do not double-claim; release happens on the last unmount", async () => {
    const modal = fakeBody.addChild({ role: "dialog" });
    const menu = fakeBody.addChild({ role: "menu" });
    await tick();

    // Only ONE suspendAll IPC despite two overlays — the observer holds a
    // single refcount entry for the whole overlay set.
    expect(ipcCalls.filter((c) => c.method === "suspendAll").length).toBe(1);
    expect(useBrowserSuspendStore.getState().count).toBe(1);

    // Closing one — overlay still in DOM, no resume.
    fakeBody.removeChild(menu);
    await tick();
    expect(useBrowserSuspendStore.getState().count).toBe(1);
    expect(ipcCalls.filter((c) => c.method === "resumeAll").length).toBe(0);

    // Closing the last — now resume fires.
    fakeBody.removeChild(modal);
    await tick();
    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls.filter((c) => c.method === "resumeAll").length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. Recognises every Radix portal shape
  // -------------------------------------------------------------------------

  test("recognises alertdialog, menu, and popper-content-wrapper", async () => {
    for (const attrs of [
      { role: "alertdialog" },
      { role: "menu" },
      { "data-radix-popper-content-wrapper": "" },
    ]) {
      resetWorld();
      const node = fakeBody.addChild(attrs);
      await tick();
      expect(useBrowserSuspendStore.getState().count).toBe(1);

      fakeBody.removeChild(node);
      await tick();
      expect(useBrowserSuspendStore.getState().count).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Coalescing — many mutations in the same tick collapse to one check
  // -------------------------------------------------------------------------

  test("multiple synchronous mutations collapse to one suspend cycle", async () => {
    // Burst of 5 overlays added in the same tick — no awaits between.
    const nodes = Array.from({ length: 5 }, () => fakeBody.addChild({ role: "dialog" }));
    await tick();

    // Only one suspendAll despite 5 mutations.
    expect(ipcCalls.filter((c) => c.method === "suspendAll").length).toBe(1);

    // Remove them all synchronously.
    for (const node of nodes) fakeBody.removeChild(node);
    await tick();
    expect(ipcCalls.filter((c) => c.method === "resumeAll").length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 5. Idempotent install
  // -------------------------------------------------------------------------

  test("calling initBrowserOverlayAutoSuspend a second time is a no-op", async () => {
    const observersBefore = fakeBody.observers.length;
    initBrowserOverlayAutoSuspend();
    expect(fakeBody.observers.length).toBe(observersBefore);
  });
});
