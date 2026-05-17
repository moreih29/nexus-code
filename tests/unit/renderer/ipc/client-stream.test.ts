import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type IpcStreamHandle, ipcStream } from "../../../../src/renderer/ipc/client";

type ProgressPayload = { step: number };
type CompletePayload = { done: boolean };
type ClientStreamEvent =
  | { streamId: string; kind: "progress"; data: ProgressPayload }
  | { streamId: string; kind: "complete"; data: CompletePayload }
  | { streamId: string; kind: "error"; data: { name?: string; message: string } };

type IpcWindowStub = {
  ipc: {
    call: ReturnType<typeof mock>;
    cancel: ReturnType<typeof mock>;
    streamStart: ReturnType<typeof mock>;
    onStreamEvent: ReturnType<typeof mock>;
    listen: ReturnType<typeof mock>;
    off: ReturnType<typeof mock>;
  };
};

const previousWindow = (globalThis as { window?: Window }).window;

let streamCallbacks: Map<string, (event: ClientStreamEvent) => void>;
let streamStart: ReturnType<typeof mock>;
let onStreamEvent: ReturnType<typeof mock>;
let cancel: ReturnType<typeof mock>;

function installWindowIpcStub(streamId = "stream-1"): void {
  streamCallbacks = new Map();
  streamStart = mock((_channel: string, _method: string, _args: unknown) =>
    Promise.resolve({ streamId }),
  );
  onStreamEvent = mock(
    (registeredStreamId: string, callback: (event: ClientStreamEvent) => void) => {
      streamCallbacks.set(registeredStreamId, callback);
      return () => {
        if (streamCallbacks.get(registeredStreamId) === callback) {
          streamCallbacks.delete(registeredStreamId);
        }
      };
    },
  );
  cancel = mock((_streamId: string) => {});

  const windowStub: IpcWindowStub = {
    ipc: {
      call: mock(() => Promise.resolve(undefined)),
      cancel,
      streamStart,
      onStreamEvent,
      listen: mock(() => {}),
      off: mock(() => {}),
    },
  };

  // Use the setter so the matchMedia-injecting window accessor in tests/setup.ts
  // remains intact (Object.defineProperty would overwrite the non-configurable accessor).
  (globalThis as Record<string, unknown>).window = windowStub;
}

function restoreWindow(): void {
  // Use the setter to restore window; the accessor installed by tests/setup.ts
  // handles injecting matchMedia when needed.
  (globalThis as Record<string, unknown>).window = previousWindow ?? undefined;
}

function startTestStream(
  args: unknown = { workspaceId: "workspace-1", query: { text: "needle" } },
  opts: { signal?: AbortSignal } = {},
): IpcStreamHandle<ProgressPayload, CompletePayload> {
  return ipcStream("fs" as never, "searchText" as never, args as never, opts) as IpcStreamHandle<
    ProgressPayload,
    CompletePayload
  >;
}

async function waitFor(predicate: () => boolean, failureMessage: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(failureMessage);
}

async function waitForRegistration(streamId = "stream-1"): Promise<void> {
  await waitFor(() => streamCallbacks.has(streamId), `expected registration for ${streamId}`);
}

function dispatchFromBridge(event: ClientStreamEvent): void {
  streamCallbacks.get(event.streamId)?.(event);
}

describe("renderer ipcStream primitive", () => {
  beforeEach(() => {
    installWindowIpcStub();
  });

  afterEach(() => {
    streamCallbacks.clear();
    restoreWindow();
  });

  test("ipcStream calls window.ipc.streamStart and registers onStreamEvent for returned streamId", async () => {
    const args = { workspaceId: "workspace-1", query: { text: "needle" } };
    const stream = startTestStream(args);

    expect(streamStart).toHaveBeenCalledWith("fs", "searchText", args);

    await waitForRegistration("stream-1");

    expect(onStreamEvent).toHaveBeenCalledTimes(1);
    expect(onStreamEvent.mock.calls[0][0]).toBe("stream-1");
    expect(onStreamEvent.mock.calls[0][1]).toEqual(expect.any(Function));

    dispatchFromBridge({ streamId: "stream-1", kind: "complete", data: { done: true } });
    await expect(stream.promise).resolves.toEqual({ done: true });
  });

  test("progress invokes registered callbacks synchronously", async () => {
    const stream = startTestStream();
    const progress = mock((_payload: ProgressPayload) => {});
    stream.onProgress(progress);
    await waitForRegistration();

    dispatchFromBridge({ streamId: "stream-1", kind: "progress", data: { step: 1 } });

    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ step: 1 });

    dispatchFromBridge({ streamId: "stream-1", kind: "complete", data: { done: true } });
    await stream.promise;
  });

  test("complete resolves promise", async () => {
    const stream = startTestStream();
    await waitForRegistration();

    dispatchFromBridge({ streamId: "stream-1", kind: "complete", data: { done: true } });

    await expect(stream.promise).resolves.toEqual({ done: true });
  });

  test("error rejects promise with Error name and message", async () => {
    const stream = startTestStream();
    const rejection = stream.promise.catch((error) => error);
    await waitForRegistration();

    dispatchFromBridge({
      streamId: "stream-1",
      kind: "error",
      data: { name: "SearchError", message: "search failed" },
    });

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SearchError");
    expect(error.message).toBe("search failed");
  });

  test("AbortSignal abort calls window.ipc.cancel(streamId) and rejects with AbortError", async () => {
    const controller = new AbortController();
    const stream = startTestStream(undefined, { signal: controller.signal });
    const rejection = stream.promise.catch((error) => error);
    await waitForRegistration();

    controller.abort();

    expect(cancel).toHaveBeenCalledWith("stream-1");
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AbortError");
    expect(error.message).toBe("The operation was aborted");
  });

  test("wrong streamId is ignored by the bridge registration map", async () => {
    const stream = startTestStream();
    const progress = mock((_payload: ProgressPayload) => {});
    stream.onProgress(progress);
    await waitForRegistration("stream-1");

    dispatchFromBridge({ streamId: "stream-2", kind: "progress", data: { step: 99 } });
    expect(progress).not.toHaveBeenCalled();

    dispatchFromBridge({ streamId: "stream-1", kind: "progress", data: { step: 1 } });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ step: 1 });

    dispatchFromBridge({ streamId: "stream-1", kind: "complete", data: { done: true } });
    await stream.promise;
  });
});
