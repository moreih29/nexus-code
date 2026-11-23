import { expect, jest, test } from "bun:test";
import { RendererBridge } from "../../../../src/main/features/cli/renderer-bridge";

test("a destroyed renderer rejects the CLI request and cancels its reply timer", async () => {
  jest.useFakeTimers();
  const gone = new Error("webContents was destroyed");
  let requestId: string | undefined;
  const bridge = new RendererBridge(() => ({
    webContents: {
      send: (_channel, _group, _event, request) => {
        requestId = (request as { requestId: string }).requestId;
        throw gone;
      },
      focus: () => {},
    },
  }));
  try {
    await expect(bridge.ask("tabs.list", { workspaceId: "test" })).rejects.toBe(gone);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    if (requestId) bridge.resolve({ requestId, ok: true, value: { tabs: [] } });
    jest.useRealTimers();
  }
});

test("aborting a CLI request cancels its pending renderer reply and timer", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const bridge = new RendererBridge(() => ({ webContents: { send: () => {}, focus: () => {} } }));
  try {
    const answer = bridge.ask("tabs.list", { workspaceId: "test" }, 15_000, controller.signal);
    expect(jest.getTimerCount()).toBe(1);
    controller.abort();
    await expect(answer).rejects.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    bridge.dispose();
    jest.useRealTimers();
  }
});

test("a request that waits on the user has no timer, and ends when the page goes", async () => {
  jest.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const bridge = new RendererBridge(() => ({
    webContents: {
      send: () => {},
      focus: () => {},
      on: (event, listener) => listeners.set(event, listener),
      removeListener: (event) => listeners.delete(event),
    },
  }));
  try {
    const answer = bridge.ask(
      "consent.ask",
      {
        fromWorkspaceId: "w1",
        fromTabId: "t1",
        toWorkspaceId: "w2",
        change: { kind: "chatInput" },
      },
      Number.POSITIVE_INFINITY,
    );
    expect(jest.getTimerCount()).toBe(0);
    expect([...listeners.keys()].sort()).toEqual([
      "destroyed",
      "did-navigate",
      "render-process-gone",
    ]);
    listeners.get("did-navigate")?.();
    await expect(answer).rejects.toThrow("NexusCode's window was reloaded or closed");
    expect(listeners.size).toBe(0);
  } finally {
    bridge.dispose();
    jest.useRealTimers();
  }
});

test("a request with a time limit does not watch the page", async () => {
  const listeners = new Map<string, () => void>();
  let requestId = "";
  const bridge = new RendererBridge(() => ({
    webContents: {
      send: (_channel, _group, _event, request) => {
        requestId = (request as { requestId: string }).requestId;
      },
      focus: () => {},
      on: (event, listener) => listeners.set(event, listener),
      removeListener: (event) => listeners.delete(event),
    },
  }));
  const answer = bridge.ask("tabs.list", { workspaceId: "test" });
  expect(listeners.size).toBe(0);
  bridge.resolve({ requestId, ok: true, value: { tabs: [] } });
  expect(await answer).toEqual({ tabs: [] });
});
