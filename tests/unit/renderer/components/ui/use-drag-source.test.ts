import { afterAll, describe, expect, mock, test } from "bun:test";
import type { EffectCallback } from "react";

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
    this.listeners.get(event.type)?.forEach((cb) => {
      cb(event);
    });
  },
  createElement(tag) {
    return { _tag: tag };
  },
};

const globals = globalThis as Record<string, unknown>;
const hadDocument = "document" in globals;
const originalDocument = globals.document;
globals.document = docStub;
afterAll(() => {
  if (hadDocument) globals.document = originalDocument;
  else delete globals.document;
});

if (typeof (globalThis as Record<string, unknown>).Event === "undefined") {
  (globalThis as Record<string, unknown>).Event = class Event {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  };
}

const pendingCleanups: Array<() => void> = [];

const realReact = await import("react");
mock.module("react", () => ({
  ...realReact,
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useRef: <T>(initial: T) => ({ current: initial }),
  useEffect: (cb: EffectCallback) => {
    const ret = cb();
    if (typeof ret === "function") pendingCleanups.push(ret);
  },
}));

function flushCleanups(): void {
  while (pendingCleanups.length > 0) {
    pendingCleanups.shift()?.();
  }
}

const ipcCalls: Array<{ channel: string; method: string; args: unknown }> = [];

const realIpcClient = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpcClient,
  ipcCallResult: mock(async (channel: string, method: string, args: unknown) => {
    ipcCalls.push({ channel, method, args });
    return { ok: true as const, value: undefined };
  }),
}));

const { useDragSource } = await import("../../../../../src/renderer/components/ui/use-drag-source");
const { useBrowserSuspendStore } = await import(
  "../../../../../src/renderer/state/stores/browser-suspend"
);

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

function buildOnDragStart() {
  // biome-ignore lint/correctness/useHookAtTopLevel: test helper exercises the hook outside of a React tree; bun:test provides the React shim.
  return useDragSource({
    mime: "application/x-nexus-tab",
    payload: { tabId: "t-1", workspaceId: "w-1" },
    dragImage: { kind: "self" },
  }).onDragStart;
}

describe("useDragSource — browser-suspend integration", () => {
  test("dragstart claims a suspend slot; dragend releases it", () => {
    useBrowserSuspendStore.setState({ count: 0 });
    ipcCalls.length = 0;

    const onDragStart = buildOnDragStart();
    const target = docStub.createElement("div");
    const event = fakeDragEvent(target);
    onDragStart(event as unknown as React.DragEvent<HTMLElement>);

    expect(useBrowserSuspendStore.getState().count).toBe(1);
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: false } },
    ]);

    docStub.dispatchEvent(new Event("dragend"));

    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls).toEqual([
      { channel: "browser", method: "suspendAll", args: { captureSnapshot: false } },
      { channel: "browser", method: "resumeAll", args: {} },
    ]);
  });

  test("dataTransfer carries the MIME at the moment the claim is issued", () => {
    useBrowserSuspendStore.setState({ count: 0 });
    ipcCalls.length = 0;

    let mimeAtClaim: readonly string[] | null = null;

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

    useBrowserSuspendStore.setState({ claim: originalClaim });
    docStub.dispatchEvent(new Event("dragend"));
  });

  test("subsequent dragend dispatches do not over-decrement the counter", () => {
    useBrowserSuspendStore.setState({ count: 0 });
    ipcCalls.length = 0;

    const onDragStart = buildOnDragStart();
    onDragStart(
      fakeDragEvent(docStub.createElement("div")) as unknown as React.DragEvent<HTMLElement>,
    );

    docStub.dispatchEvent(new Event("dragend"));
    docStub.dispatchEvent(new Event("dragend"));

    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls.filter((c) => c.method === "resumeAll").length).toBe(1);
  });

  test("unmount mid-drag releases the claim even when dragend never fires", () => {
    useBrowserSuspendStore.setState({ count: 0 });
    ipcCalls.length = 0;
    pendingCleanups.length = 0;

    const onDragStart = buildOnDragStart();
    onDragStart(
      fakeDragEvent(docStub.createElement("div")) as unknown as React.DragEvent<HTMLElement>,
    );

    expect(useBrowserSuspendStore.getState().count).toBe(1);

    flushCleanups();

    expect(useBrowserSuspendStore.getState().count).toBe(0);
    expect(ipcCalls.filter((c) => c.method === "resumeAll").length).toBe(1);
  });
});
