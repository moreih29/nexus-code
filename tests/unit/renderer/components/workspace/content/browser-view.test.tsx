/**
 * BrowserTabView unit tests — reparent → setBounds regression guard.
 *
 * The initial-URL decision (`resolveInitialBrowserUrl`) is covered in
 * tests/unit/renderer/state/operations/browser.test.ts.
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

import { describe, expect, it, mock } from "bun:test";

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
// Following the ref-chip.test.tsx precedent, we drive BrowserTabView through a
// minimal React hook dispatcher (no renderer): invoke it once to collect its
// effects, then run the reparent effect with a fake measurable placeholder and
// a synchronous rAF — asserting it emits the `browser.setBounds` IPC. This
// DISCRIMINATES the fix: on the pre-fix code there is no effect keyed on
// `parentEl`, so the lookup below returns undefined and the test fails.
//
// CROSS-FILE ISOLATION: other test files (e.g. use-drag-source.test.ts) call
// `mock.module("react", …)` with hooks that run effects immediately and return
// non-stable refs. bun's module mocks are process-global and not reset between
// files, so that mock leaks here and would crash BrowserTabView mid-render. We
// neutralize it by re-mocking react with hooks that DELEGATE to React's current
// internal dispatcher: our harness sets that dispatcher during a render, and
// any other file remains unaffected (its own renders set their own dispatcher).
//
// Out of scope (manual / isolated-instance smoke): real native view geometry.

interface RefSlot {
  current: unknown;
}

interface HookDispatcher {
  useRef(initial: unknown): RefSlot;
  useState(initial: unknown): [unknown, (v: unknown) => void];
  useCallback(cb: unknown, deps?: readonly unknown[]): unknown;
  useMemo(factory: () => unknown, deps?: readonly unknown[]): unknown;
  useEffect(fn: () => void, deps?: readonly unknown[]): void;
}

interface CapturedEffect {
  // `() => void` structurally accepts effect callbacks that return a cleanup
  // function too; the harness never invokes the cleanup, so this is sufficient.
  fn: () => void;
  deps: readonly unknown[] | undefined;
}

// React's current-dispatcher slot. Reading it off the (possibly already-mocked)
// react module namespace keeps us pointed at the same object the runtime uses.
const currentReact = await import("react");
const reactInternals = (
  currentReact as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: HookDispatcher | null };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// Transparent delegating mock — overrides any leaked global react hook mock.
mock.module("react", () => ({
  ...currentReact,
  useRef: (init: unknown) => reactInternals.H?.useRef(init),
  useState: (init: unknown) => reactInternals.H?.useState(init),
  useCallback: (cb: unknown, deps?: readonly unknown[]) => reactInternals.H?.useCallback(cb, deps),
  useMemo: (f: () => unknown, deps?: readonly unknown[]) => reactInternals.H?.useMemo(f, deps),
  useEffect: (fn: () => void, deps?: readonly unknown[]) => reactInternals.H?.useEffect(fn, deps),
}));

// Minimal hook dispatcher: slot-indexed refs/state, callbacks passed through,
// effects captured with their dependency arrays.
function createHookHarness() {
  const refs: RefSlot[] = [];
  const states: unknown[] = [];
  const effects: CapturedEffect[] = [];
  let refCursor = 0;
  let stateCursor = 0;

  const dispatcher: HookDispatcher = {
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
    const previous = reactInternals.H;
    reactInternals.H = dispatcher;
    try {
      run();
    } finally {
      reactInternals.H = previous;
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
