/**
 * Unit tests for the drag-source ↔ browser-suspend integration in
 * {@link useDragSource}.
 *
 * The browser-suspend claim has to happen in React's bubble-phase
 * `onDragStart` callback — not in a document-level capture listener —
 * otherwise `dataTransfer.setData()` (which also runs in bubble phase)
 * hasn't populated MIME types yet and an upstream MIME gate races to
 * `false`.  This is the bug fixed by routing the claim through
 * `useDragSource` itself; these tests pin that contract.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal document stub — bun:test has no jsdom by default.  We only need
// `addEventListener` / `removeEventListener` / `dispatchEvent` plus a way to
// build placeholder elements that satisfy `event.currentTarget` typing.
// ---------------------------------------------------------------------------

interface DocStub {
  listeners: Map<string, Set<(e: Event) => void>>;
  addEventListener(type: string, cb: (e: Event) => void): void;
  removeEventListener(type: string, cb: (e: Event) => void): void;
  dispatchEvent(event: Event): void;
  createElement(_tag: string): { _tag: string };
}

const docStub: DocStub = {
  listeners: new Map(),
  addEventListener(type, cb) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  },
  removeEventListener(type, cb) {
    this.listeners.get(type)?.delete(cb);
  },
  dispatchEvent(event) {
    this.listeners.get(event.type)?.forEach((cb) => cb(event));
  },
  createElement(tag) {
    return { _tag: tag };
  },
};

(globalThis as Record<string, unknown>).document = docStub;

// Lightweight Event polyfill — bun:test does not expose a DOM Event class by
// default.  Only the `type` field matters for our dispatch path.
if (typeof (globalThis as Record<string, unknown>).Event === "undefined") {
  (globalThis as Record<string, unknown>).Event = class Event {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  };
}

// ---------------------------------------------------------------------------
// Mock react.useCallback as identity — the hook is invoked outside a render
// tree in these tests, but its only React dependency is the useCallback
// wrapper.  Mirrors the pattern used in `ref-chip.test.tsx`.
// ---------------------------------------------------------------------------

const realReact = await import("react");
mock.module("react", () => ({
  ...realReact,
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
}));

// ---------------------------------------------------------------------------
// Mock the IPC client so the suspend store can call suspendAll/resumeAll
// without hitting a real preload bridge.
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

// Re-import after the mock has been registered so the store binds to it.
const { useDragSource } = await import(
  "../../../../../src/renderer/components/ui/use-drag-source"
);
const { useBrowserSuspendStore } = await import(
  "../../../../../src/renderer/state/stores/browser-suspend"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeDataTransfer {
  effectAllowed: DataTransfer["effectAllowed"];
  data: Map<string, string>;
  setData(mime: string, value: string): void;
  setDragImage: ReturnType<typeof mock>;
}

function fakeDataTransfer(): FakeDataTransfer {
  const data = new Map<string, string>();
  return {
    effectAllowed: "uninitialized",
    data,
    setData(mime: string, value: string) {
      data.set(mime, value);
    },
    setDragImage: mock(() => {}),
  };
}

function fakeDragEvent(currentTarget: unknown): {
  dataTransfer: FakeDataTransfer;
  currentTarget: unknown;
} {
  return {
    dataTransfer: fakeDataTransfer(),
    currentTarget,
  };
}

/**
 * Manually invoke the React-style `onDragStart` callback returned by the hook.
 *
 * The hook is exercised by calling it directly — React's renderer is not
 * required: `useCallback` with no React-tree state behaves like an identity
 * over its dependencies, and Bun's test runner provides the React module so
 * the hook body resolves without throwing.
 */
function buildOnDragStart() {
  // Drive the hook through its public surface — useDragSource is exported
  // independent of React rendering, so the returned callback can be invoked
  // directly in tests.
  return useDragSource({
    mime: "application/x-nexus-tab",
    payload: { tabId: "t-1", workspaceId: "w-1" },
    dragImage: { kind: "self" },
  }).onDragStart;
}

describe("useDragSource — browser-suspend integration", () => {
  // -------------------------------------------------------------------------
  // 1. onDragStart claims a suspend slot; dragend releases it.
  // -------------------------------------------------------------------------

  test("dragstart claims a suspend slot; dragend releases it", () => {
    // Counter starts at 0 (no prior drags).
    useBrowserSuspendStore.setState({ count: 0 });
    ipcCalls.length = 0;

    const onDragStart = buildOnDragStart();
    const target = docStub.createElement("div");
    const event = fakeDragEvent(target);
    // The hook expects a React.DragEvent shape; only the fields it touches
    // need to be present.
    onDragStart(event as unknown as React.DragEvent<HTMLElement>);

    // After dragstart: count=1, suspendAll IPC fired exactly once.
    expect(useBrowserSuspendStore.getState().count).toBe(1);
    expect(ipcCalls).toEqual([{ channel: "browser", method: "suspendAll", args: { captureSnapshot: false } }]);

    // Simulate dragend on document — our one-shot listener should fire.
    docStub.dispatchEvent(new Event("dragend"));

    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: false } },
      { channel: "browser", method: "resumeAll", args: {} },
    ]);
  });

  // -------------------------------------------------------------------------
  // 2. setData still populates the MIME before the claim runs.
  //
  // Pins the ordering that motivates routing the claim through React's
  // bubble-phase handler instead of a document-capture listener.
  // -------------------------------------------------------------------------

  test("dataTransfer carries the MIME at the moment the claim is issued", () => {
    useBrowserSuspendStore.setState({ count: 0 });
    ipcCalls.length = 0;

    let mimeAtClaim: readonly string[] | null = null;

    // Spy on the store so we can capture the MIME state synchronously when
    // claim() is invoked from inside onDragStart.
    const originalClaim = useBrowserSuspendStore.getState().claim;
    useBrowserSuspendStore.setState({
      claim: () => {
        mimeAtClaim = Array.from(currentEvent.dataTransfer.data.keys());
        return originalClaim();
      },
    });

    const onDragStart = buildOnDragStart();
    const target = docStub.createElement("div");
    const currentEvent = fakeDragEvent(target);

    onDragStart(currentEvent as unknown as React.DragEvent<HTMLElement>);

    expect(mimeAtClaim).not.toBeNull();
    expect(mimeAtClaim).toContain("application/x-nexus-tab");

    // Restore the original claim for downstream tests.
    useBrowserSuspendStore.setState({ claim: originalClaim });
    docStub.dispatchEvent(new Event("dragend"));
  });

  // -------------------------------------------------------------------------
  // 3. dragend listener is one-shot — extra dragends do not over-release.
  // -------------------------------------------------------------------------

  test("subsequent dragend dispatches do not over-decrement the counter", () => {
    useBrowserSuspendStore.setState({ count: 0 });
    ipcCalls.length = 0;

    const onDragStart = buildOnDragStart();
    onDragStart(
      fakeDragEvent(docStub.createElement("div")) as unknown as React.DragEvent<HTMLElement>,
    );

    docStub.dispatchEvent(new Event("dragend")); // expected release
    docStub.dispatchEvent(new Event("dragend")); // extra — must be a no-op

    expect(useBrowserSuspendStore.getState().count).toBe(0);
    // Only one resumeAll, not two.
    expect(ipcCalls.filter((c) => c.method === "resumeAll").length).toBe(1);
  });
});
