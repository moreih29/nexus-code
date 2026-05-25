/**
 * Unit tests for `installAppScrollbarStyle`.
 *
 * The injection has to satisfy three contracts:
 *   1. Re-inject on every `did-finish-load` — a cross-document navigation
 *      discards previously inserted CSS so we cannot inject just once.
 *   2. If the WebContents has already finished its initial load by the time
 *      the hook runs (a race against `loadURL`), inject immediately.
 *   3. Tolerate `insertCSS` failures: log and continue — a failed scrollbar
 *      injection should never break navigation.
 */

import { describe, expect, mock, test } from "bun:test";
import { installAppScrollbarStyle } from "../../../../../src/main/features/browser/page-style";

interface FakeWebContents {
  destroyed: boolean;
  loading: boolean;
  listeners: Map<string, Array<() => void>>;
  insertCSSCalls: string[];
  insertCSSRejection: Error | null;
  on(event: string, cb: () => void): void;
  isDestroyed(): boolean;
  isLoading(): boolean;
  insertCSS(css: string): Promise<string>;
  emit(event: string): void;
}

function fakeWebContents(opts?: { loading?: boolean; destroyed?: boolean }): FakeWebContents {
  return {
    destroyed: opts?.destroyed ?? false,
    loading: opts?.loading ?? false,
    listeners: new Map(),
    insertCSSCalls: [],
    insertCSSRejection: null,
    on(event, cb) {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
    },
    isDestroyed() {
      return this.destroyed;
    },
    isLoading() {
      return this.loading;
    },
    insertCSS(css) {
      this.insertCSSCalls.push(css);
      if (this.insertCSSRejection) {
        return Promise.reject(this.insertCSSRejection);
      }
      return Promise.resolve("css-key");
    },
    emit(event) {
      this.listeners.get(event)?.forEach((cb) => cb());
    },
  };
}

describe("installAppScrollbarStyle", () => {
  // -------------------------------------------------------------------------
  // 1. Initial injection when the WebContents is already idle
  // -------------------------------------------------------------------------

  test("injects immediately when isLoading() returns false at install time", () => {
    const wc = fakeWebContents({ loading: false });

    installAppScrollbarStyle(wc as unknown as import("electron").WebContents);

    // Initial injection ran exactly once (loading=false branch).
    expect(wc.insertCSSCalls.length).toBe(1);
    expect(wc.insertCSSCalls[0]).toContain("::-webkit-scrollbar");
  });

  // -------------------------------------------------------------------------
  // 2. No initial injection while still loading; did-finish-load triggers it
  // -------------------------------------------------------------------------

  test("defers initial injection when isLoading() is true; did-finish-load fires it", () => {
    const wc = fakeWebContents({ loading: true });

    installAppScrollbarStyle(wc as unknown as import("electron").WebContents);
    expect(wc.insertCSSCalls.length).toBe(0);

    wc.emit("did-finish-load");
    expect(wc.insertCSSCalls.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. Re-injection on every did-finish-load
  // -------------------------------------------------------------------------

  test("re-injects on every did-finish-load (covers cross-document navigation)", () => {
    const wc = fakeWebContents({ loading: false });

    installAppScrollbarStyle(wc as unknown as import("electron").WebContents);

    // Three navigations after the initial install — each should re-inject.
    wc.emit("did-finish-load");
    wc.emit("did-finish-load");
    wc.emit("did-finish-load");

    // 1 (initial) + 3 (navigations) = 4.
    expect(wc.insertCSSCalls.length).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 4. Destroyed guard
  // -------------------------------------------------------------------------

  test("skips injection when WebContents is destroyed", () => {
    const wc = fakeWebContents({ loading: false, destroyed: true });

    installAppScrollbarStyle(wc as unknown as import("electron").WebContents);

    // Even the initial sync attempt is gated by isDestroyed().
    expect(wc.insertCSSCalls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. insertCSS rejection is swallowed
  // -------------------------------------------------------------------------

  test("insertCSS rejection does not throw out of the injector", async () => {
    const wc = fakeWebContents({ loading: false });
    wc.insertCSSRejection = new Error("boom");

    // Must not throw synchronously.
    expect(() => {
      installAppScrollbarStyle(wc as unknown as import("electron").WebContents);
    }).not.toThrow();

    // The error is logged via the createLogger surface, not the test runner —
    // we only assert that the rejection didn't propagate.  Give the microtask
    // queue a tick to surface any unhandled rejection.
    await Promise.resolve();
  });

  // -------------------------------------------------------------------------
  // 6. CSS payload sanity — selectors + width + !important
  // -------------------------------------------------------------------------

  test("CSS payload covers scrollbar, track, thumb, hover, corner, with !important", () => {
    const wc = fakeWebContents({ loading: false });
    installAppScrollbarStyle(wc as unknown as import("electron").WebContents);

    const css = wc.insertCSSCalls[0];
    expect(css).toContain("::-webkit-scrollbar");
    expect(css).toContain("::-webkit-scrollbar-track");
    expect(css).toContain("::-webkit-scrollbar-thumb");
    expect(css).toContain("::-webkit-scrollbar-thumb:hover");
    expect(css).toContain("::-webkit-scrollbar-corner");
    expect(css).toContain("!important");
    // Width matches the app's @utility app-scrollbar (10/8).
    expect(css).toMatch(/width:\s*10px/);
    expect(css).toMatch(/height:\s*8px/);
  });
});
