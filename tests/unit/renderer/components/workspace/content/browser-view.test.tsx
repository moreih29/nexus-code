/**
 * BrowserTabView — initial URL resolution unit tests.
 *
 * Verifies the URL decision that BrowserTabView makes on mount:
 *   resolveInitialBrowserUrl(tab.props) ?? "about:blank"
 *
 * Test cases covering the two acceptance-criteria scenarios:
 *   1. lastUrl="javascript:alert(1)" → resolves to null → component uses about:blank
 *   2. lastUrl="https://example.com"  → resolves to the URL → component uses it directly
 *   3. lastUrl="" (empty tab)          → resolves to null → component uses about:blank
 *   4. null-coalescing: non-null result passes through unchanged
 *   5. null result falls back to BLANK_TAB_URL ("about:blank")
 *
 * Why this approach:
 *   bun:test runs in a pure JavaScript environment with no DOM (document/window
 *   are unavailable). React's createRoot requires a real DOM node, so full-mount
 *   tests are not feasible without adding a DOM-simulator dependency (forbidden by
 *   constraints). Instead we test the URL decision logic — which is the single
 *   change introduced by this task — via the same resolveInitialBrowserUrl call
 *   that the component now uses, paired with the null-coalesce-to-BLANK_TAB_URL
 *   step. This covers the complete URL resolution path from props to the value
 *   that reaches ipcCallResult("browser", "create", { url }).
 *
 * The DOM-level assertion (that ipcCallResult actually receives the URL) is
 * covered by the integration / E2E test suite (Tester scope). The unit tests
 * here guard the URL decision logic that feeds into that call.
 */

// ---------------------------------------------------------------------------
// Shim window.ipc so imports of ipc/client do not throw.
// (Same pattern as browser.test.ts in the operations layer.)
// ---------------------------------------------------------------------------
(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Imports (after shims)
// ---------------------------------------------------------------------------

import { describe, expect, it, mock } from "bun:test";
import * as React from "react";
import { resolveInitialBrowserUrl } from "../../../../../../src/renderer/state/operations/browser";
import type { BrowserTabProps } from "../../../../../../src/renderer/state/stores/tabs";

// ---------------------------------------------------------------------------
// Constants — mirror the private constant in browser-view.tsx so tests remain
// decoupled from the implementation file.
// ---------------------------------------------------------------------------

const BLANK_TAB_URL = "about:blank";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal BrowserTabProps for test purposes.
 * Mirrors the props that BrowserTabView receives from host.tsx.
 */
function makeProps(lastUrl: string, initialUrl = ""): BrowserTabProps {
  return {
    initialUrl,
    lastUrl,
    partition: "persist:browser-test-ws",
  };
}

/**
 * Replicate the exact URL computation that BrowserTabView performs on mount:
 *   resolveInitialBrowserUrl({ initialUrl, lastUrl, partition }) ?? BLANK_TAB_URL
 *
 * This function is the single source-of-truth under test — it is structurally
 * identical to the expression inserted into browser-view.tsx.
 */
function computeMountUrl(lastUrl: string, initialUrl = ""): string {
  return resolveInitialBrowserUrl(makeProps(lastUrl, initialUrl)) ?? BLANK_TAB_URL;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BrowserTabView — computeMountUrl (resolveInitialBrowserUrl ?? BLANK_TAB_URL)", () => {
  // Acceptance-criteria scenario 1: dangerous scheme → about:blank
  it("returns about:blank when lastUrl is javascript: (blocked by allowlist)", () => {
    expect(computeMountUrl("javascript:alert(1)")).toBe(BLANK_TAB_URL);
  });

  // Acceptance-criteria scenario 2: valid https URL → preserved
  it("returns the lastUrl when it is a valid https URL", () => {
    expect(computeMountUrl("https://example.com")).toBe("https://example.com");
  });

  // Complementary case: empty lastUrl (new tab) → about:blank
  it("returns about:blank when lastUrl is empty", () => {
    expect(computeMountUrl("")).toBe(BLANK_TAB_URL);
  });

  // Valid http URL passes through
  it("returns the lastUrl when it is a valid http URL", () => {
    expect(computeMountUrl("http://example.com/path")).toBe("http://example.com/path");
  });

  // data: scheme is blocked → about:blank
  it("returns about:blank when lastUrl is a data: scheme", () => {
    expect(computeMountUrl("data:text/html,<h1>hi</h1>")).toBe(BLANK_TAB_URL);
  });

  // null-coalescing: resolveInitialBrowserUrl returns null → falls back to BLANK_TAB_URL.
  // Use a scheme that is genuinely blocked (javascript:) — file: was previously blocked
  // but is now explicitly allowed per navigation-allowlist.ts (users may open local HTML).
  it("falls back to BLANK_TAB_URL when resolveInitialBrowserUrl returns null", () => {
    const result = resolveInitialBrowserUrl(makeProps("javascript:void(0)"));
    expect(result).toBeNull();
    // Component computes: result ?? BLANK_TAB_URL
    const mountUrl = result ?? BLANK_TAB_URL;
    expect(mountUrl).toBe(BLANK_TAB_URL);
  });

  // non-null result passes through null-coalescing unchanged
  it("passes through a non-null URL from resolveInitialBrowserUrl unchanged", () => {
    const result = resolveInitialBrowserUrl(makeProps("https://valid.example.com"));
    expect(result).toBe("https://valid.example.com");
    // Component computes: result ?? BLANK_TAB_URL
    const mountUrl = result ?? BLANK_TAB_URL;
    expect(mountUrl).toBe("https://valid.example.com");
  });
});

// ===========================================================================
// BrowserTabView — reparent → setBounds regression guard
// ===========================================================================
//
// THE BUG (startup-timing race, only reproduced in fast release builds)
// ---------------------------------------------------------------------
// The native WebContentsView is positioned by the CSS-pixel bounds the
// renderer measures from a placeholder <div>. ContentHost reparents that
// placeholder between the leaf slot and an off-screen view park. A reparent
// moves the placeholder to a NEW on-screen position WITHOUT changing its size,
// so `ResizeObserver` never fires. Before the fix, the view stayed pinned at
// the pre-reparent coordinates until an unrelated resize corrected it.
//
// THE FIX: BrowserTabView gained a `parentEl` prop and an effect
//   useEffect(() => { if (parentEl === null) return; scheduleSendBounds(); },
//             [parentEl, scheduleSendBounds]);
// that re-measures on every reparent — timing-independent.
//
// WHY A HOOK HARNESS (no DOM mount)
// ---------------------------------
// This project does not use jsdom/happy-dom (forbidden — caused test hangs).
// Following the ref-chip.test.tsx precedent, we install a minimal React hook
// dispatcher, invoke BrowserTabView once to collect its effects, then run the
// reparent effect with a fake measurable placeholder and a synchronous rAF —
// asserting it emits the `browser.setBounds` IPC. This DISCRIMINATES the fix:
// on the pre-fix code there is no effect keyed on `parentEl`, so the lookup
// below returns undefined and the test fails.
//
// Out of scope (manual / isolated-instance smoke): real native view geometry.

interface CapturedEffect {
  // `() => void` structurally accepts effect callbacks that return a cleanup
  // function too; the harness never invokes the cleanup, so this is sufficient.
  fn: () => void;
  deps: readonly unknown[] | undefined;
}

interface RefSlot {
  current: unknown;
}

// Minimal hook dispatcher: slot-indexed refs/state, callbacks passed through,
// effects captured with their dependency arrays.
function createHookHarness() {
  const refs: RefSlot[] = [];
  const states: unknown[] = [];
  const effects: CapturedEffect[] = [];
  let refCursor = 0;
  let stateCursor = 0;

  const dispatcher = {
    useRef(initial: unknown): RefSlot {
      const i = refCursor++;
      if (!(i in refs)) refs[i] = { current: initial };
      return refs[i];
    },
    useState(initial: unknown): [unknown, (v: unknown) => void] {
      const i = stateCursor++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [states[i], () => {}];
    },
    useCallback: (cb: unknown) => cb,
    useMemo: (factory: () => unknown) => factory(),
    useEffect: (fn: () => void, deps?: readonly unknown[]) => {
      effects.push({ fn, deps });
    },
  };

  function render(run: () => void): void {
    refCursor = 0;
    stateCursor = 0;
    effects.length = 0;
    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      run();
    } finally {
      internals.H = previous;
    }
  }

  return { refs, effects, render };
}

// Capture browser.* IPC calls; stub the runtime store so no real IPC is needed.
const setBoundsCalls: Array<Record<string, unknown>> = [];
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, method: string, args: Record<string, unknown>) => {
    if (channel === "browser" && method === "setBounds") setBoundsCalls.push(args);
    return Promise.resolve({ ok: true as const, value: undefined });
  },
  ipcListen: () => () => {},
}));
mock.module("../../../../../../src/renderer/state/stores/browser-runtime", () => {
  const useBrowserRuntimeStore = (() => undefined) as unknown as {
    (): undefined;
    getState: () => { removeRuntime: () => void };
  };
  useBrowserRuntimeStore.getState = () => ({ removeRuntime: () => {} });
  return { useBrowserRuntimeStore };
});

const { BrowserTabView } = await import(
  "../../../../../../src/renderer/components/workspace/content/browser-view"
);

describe("BrowserTabView — reparent re-measures bounds (regression guard)", () => {
  it("a parentEl change schedules a setBounds IPC with the placeholder's measured rect", () => {
    const harness = createHookHarness();
    // Unique sentinel so we can identify the effect keyed on parentEl.
    const PARENT_EL = { id: "slot" } as unknown as HTMLElement;

    harness.render(() => {
      (BrowserTabView as unknown as (p: Record<string, unknown>) => unknown)({
        tabId: "tab-1",
        workspaceId: "ws-1",
        initialUrl: "",
        lastUrl: "https://example.com",
        partition: "persist:browser-ws-1",
        isActive: true,
        parentEl: PARENT_EL,
      });
    });

    // placeholderRef is the first useRef; give it a fake measurable element.
    // devtoolsPlaceholderRef (2nd) stays null so setDevToolsBounds is skipped.
    const rect = {
      left: 100,
      top: 50,
      width: 800,
      height: 600,
      right: 900,
      bottom: 650,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    };
    harness.refs[0].current = { getBoundingClientRect: () => rect };

    // Run rAF callbacks synchronously so scheduleSendBounds → sendBounds fires now.
    const realRaf = globalThis.requestAnimationFrame;
    const realCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;

    try {
      // The reparent effect is the only one closing over parentEl in its deps.
      const reparentEffect = harness.effects.find(
        (e) => Array.isArray(e.deps) && e.deps.includes(PARENT_EL),
      );
      // On the pre-fix code no such effect exists → this assertion fails (the
      // discriminator).
      expect(reparentEffect).toBeDefined();

      setBoundsCalls.length = 0;
      reparentEffect?.fn();

      expect(setBoundsCalls).toHaveLength(1);
      expect(setBoundsCalls[0]).toEqual({
        tabId: "tab-1",
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    } finally {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    }
  });

  it("the reparent effect no-ops when parentEl is null (no bounds sent)", () => {
    const harness = createHookHarness();
    harness.render(() => {
      (BrowserTabView as unknown as (p: Record<string, unknown>) => unknown)({
        tabId: "tab-2",
        workspaceId: "ws-1",
        initialUrl: "",
        lastUrl: "",
        partition: "persist:browser-ws-1",
        isActive: false,
        parentEl: null,
      });
    });

    harness.refs[0].current = { getBoundingClientRect: () => ({}) };
    const realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      // With parentEl null the reparent effect's deps are [null, scheduleSendBounds].
      // Identify it as the 2-dep effect whose first dep is null, run it, and
      // confirm the `if (parentEl === null) return` guard suppresses the send.
      const candidate = harness.effects.find(
        (e) => Array.isArray(e.deps) && e.deps.length === 2 && e.deps[0] === null,
      );
      expect(candidate).toBeDefined();
      setBoundsCalls.length = 0;
      candidate?.fn();
      expect(setBoundsCalls).toHaveLength(0);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });
});
