import { beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";

const realIpcContract = await import("../../../../src/shared/ipc/ipc-contract");

const StreamArgsSchema = z.object({ token: z.string() });
const StreamProgressSchema = z.object({ step: z.number() });
const StreamCompleteSchema = z.object({ done: z.boolean() });

mock.module("../../../../src/shared/ipc/ipc-contract", () => ({
  ...realIpcContract,
  ipcContract: {
    ...realIpcContract.ipcContract,
    streamTest: {
      call: {},
      listen: {},
      stream: {
        yields: {
          args: StreamArgsSchema,
          progress: StreamProgressSchema,
          result: StreamCompleteSchema,
        },
        completes: {
          args: StreamArgsSchema,
          progress: StreamProgressSchema,
          result: StreamCompleteSchema,
        },
        throws: {
          args: StreamArgsSchema,
          progress: StreamProgressSchema,
          result: StreamCompleteSchema,
        },
        cancellable: {
          args: StreamArgsSchema,
          progress: StreamProgressSchema,
          result: StreamCompleteSchema,
        },
        handledCancel: {
          args: StreamArgsSchema,
          progress: StreamProgressSchema,
          result: StreamCompleteSchema,
          cancelMode: "handler",
        },
        invalidProgress: {
          args: StreamArgsSchema,
          progress: StreamProgressSchema,
          result: StreamCompleteSchema,
        },
        senderTargeted: {
          args: StreamArgsSchema,
          progress: StreamProgressSchema,
          result: StreamCompleteSchema,
        },
      },
    },
  },
}));

const mockHandle = mock((_channel: string, _handler: unknown) => {});
const mockOn = mock((_channel: string, _handler: unknown) => {});
const mockGetAllWebContents = mock(() => [] as TestSender[]);

mock.module("electron", () => ({
  ipcMain: {
    handle: mockHandle,
    on: mockOn,
  },
  webContents: {
    getAllWebContents: mockGetAllWebContents,
  },
}));

const { register, setupRouter } = await import("../../../../src/main/infra/ipc-router");

setupRouter();

type StreamPayload =
  | { streamId: string; kind: "progress"; data: unknown }
  | { streamId: string; kind: "complete"; data: unknown }
  | { streamId: string; kind: "error"; data: { name: string; message: string } };

type StreamStartHandler = (
  event: { sender: TestSender },
  channelName: string,
  method: string,
  args: unknown,
) => Promise<{ streamId: string }>;

type CancelHandler = (event: { sender?: { id?: number } }, requestId: unknown) => void;

type TestStreamHandler = (
  args: { token: string },
  ctx: { signal: AbortSignal },
) => AsyncGenerator<unknown, unknown, unknown> | Promise<AsyncGenerator<unknown, unknown, unknown>>;

function makeSender(id: number) {
  return {
    id,
    send: mock((_channel: string, _payload: StreamPayload) => {}),
    isDestroyed: () => false,
  };
}

type TestSender = ReturnType<typeof makeSender>;

function getStreamStartHandler(): StreamStartHandler {
  const calls = mockHandle.mock.calls as [string, StreamStartHandler][];
  const entry = calls.find(([channel]) => channel === "ipc:streamStart");
  if (!entry) throw new Error("ipcMain.handle('ipc:streamStart') was not called");
  return entry[1];
}

function getCancelHandler(): CancelHandler {
  const calls = mockOn.mock.calls as [string, CancelHandler][];
  const entry = calls.find(([channel]) => channel === "ipc:cancel");
  if (!entry) throw new Error("ipcMain.on('ipc:cancel') was not called");
  return entry[1];
}

function registerStream(method: string, handler: TestStreamHandler): void {
  register("streamTest", {
    call: {},
    listen: {},
    stream: {
      [method]: handler,
    },
  });
}

function streamEvents(sender: TestSender): StreamPayload[] {
  return sender.send.mock.calls
    .filter(([channel]) => channel === "ipc:streamEvent")
    .map(([, payload]) => payload as StreamPayload);
}

function streamEventsByKind<K extends StreamPayload["kind"]>(
  sender: TestSender,
  kind: K,
): Extract<StreamPayload, { kind: K }>[] {
  return streamEvents(sender).filter(
    (payload): payload is Extract<StreamPayload, { kind: K }> => payload.kind === kind,
  );
}

async function waitFor(predicate: () => boolean, failureMessage: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(failureMessage);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ipc router stream primitive", () => {
  beforeEach(() => {
    mockGetAllWebContents.mockImplementation(() => []);
  });

  test("streamStart returns a streamId and sends progress events for generator yields", async () => {
    registerStream("yields", async function* stream() {
      yield { step: 1 };
      yield { step: 2 };
      yield { step: 3 };
      return { done: true };
    });

    const sender = makeSender(1);
    const result = await getStreamStartHandler()({ sender }, "streamTest", "yields", {
      token: "ok",
    });

    expect(result.streamId).toEqual(expect.any(String));
    expect(result.streamId.length).toBeGreaterThan(0);

    await waitFor(
      () => streamEventsByKind(sender, "progress").length === 3,
      "expected three progress events",
    );

    expect(streamEventsByKind(sender, "progress")).toEqual([
      { streamId: result.streamId, kind: "progress", data: { step: 1 } },
      { streamId: result.streamId, kind: "progress", data: { step: 2 } },
      { streamId: result.streamId, kind: "progress", data: { step: 3 } },
    ]);
  });

  test('generator return sends kind: "complete"', async () => {
    registerStream("completes", async function* stream() {
      yield { step: 1 };
      return { done: true };
    });

    const sender = makeSender(2);
    const result = await getStreamStartHandler()({ sender }, "streamTest", "completes", {
      token: "ok",
    });

    await waitFor(
      () => streamEventsByKind(sender, "complete").length === 1,
      "expected one complete event",
    );

    expect(streamEventsByKind(sender, "complete")).toEqual([
      { streamId: result.streamId, kind: "complete", data: { done: true } },
    ]);
  });

  test('generator throw sends kind: "error"', async () => {
    registerStream("throws", async function* stream() {
      yield { step: 1 };
      throw new TypeError("stream exploded");
    });

    const sender = makeSender(3);
    const result = await getStreamStartHandler()({ sender }, "streamTest", "throws", {
      token: "ok",
    });

    await waitFor(
      () => streamEventsByKind(sender, "error").length === 1,
      "expected one error event",
    );

    expect(streamEventsByKind(sender, "error")).toEqual([
      {
        streamId: result.streamId,
        kind: "error",
        data: { name: "TypeError", message: "stream exploded" },
      },
    ]);
  });

  test("ipc:cancel aborts the matching stream, calls generator.return(), and sends no later progress", async () => {
    const nextResult = deferred<IteratorResult<unknown, unknown>>();
    const next = mock(() => nextResult.promise);
    const returnGenerator = mock(() =>
      Promise.resolve({ done: true, value: undefined } as IteratorResult<unknown, unknown>),
    );
    const generator = {
      next,
      return: returnGenerator,
      throw: mock(() =>
        Promise.resolve({ done: true, value: undefined } as IteratorResult<unknown, unknown>),
      ),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as AsyncGenerator<unknown, unknown, unknown>;

    registerStream("cancellable", () => generator);

    const sender = makeSender(4);
    const event = { sender };
    const result = await getStreamStartHandler()(event, "streamTest", "cancellable", {
      token: "ok",
    });

    await waitFor(() => next.mock.calls.length === 1, "expected generator.next to be active");

    getCancelHandler()(event, result.streamId);

    expect(returnGenerator).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith("ipc:streamEvent", {
      streamId: result.streamId,
      kind: "error",
      data: { name: "AbortError", message: "The operation was aborted" },
    });

    nextResult.resolve({ done: false, value: { step: 99 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(streamEventsByKind(sender, "progress")).toHaveLength(0);
  });

  test("handler-owned cancellation lets a stream emit final domain progress and complete", async () => {
    registerStream("handledCancel", async function* stream(_args, ctx) {
      while (!ctx.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      yield { step: 9 };
      return { done: true };
    });

    const sender = makeSender(8);
    const event = { sender };
    const result = await getStreamStartHandler()(event, "streamTest", "handledCancel", {
      token: "ok",
    });

    getCancelHandler()(event, result.streamId);

    await waitFor(
      () => streamEventsByKind(sender, "complete").length === 1,
      "expected handler-owned cancel to complete",
    );

    expect(streamEvents(sender)).toEqual([
      { streamId: result.streamId, kind: "progress", data: { step: 9 } },
      { streamId: result.streamId, kind: "complete", data: { done: true } },
    ]);
  });

  test('zod progress payload validation failure sends kind: "error"', async () => {
    registerStream("invalidProgress", async function* stream() {
      yield { step: "not-a-number" };
      return { done: true };
    });

    const sender = makeSender(5);
    const result = await getStreamStartHandler()({ sender }, "streamTest", "invalidProgress", {
      token: "ok",
    });

    await waitFor(
      () => streamEventsByKind(sender, "error").length === 1,
      "expected one validation error event",
    );

    const [errorEvent] = streamEventsByKind(sender, "error");
    expect(errorEvent.streamId).toBe(result.streamId);
    expect(errorEvent.kind).toBe("error");
    expect(errorEvent.data.name).toBe("Error");
    expect(errorEvent.data.message).toContain("ipc:streamStart — invalid progress");
  });

  test("sender-targeted send only calls the invoking webContents", async () => {
    registerStream("senderTargeted", async function* stream() {
      yield { step: 1 };
      return { done: true };
    });

    const invokingSender = makeSender(6);
    const otherSender = makeSender(7);
    mockGetAllWebContents.mockImplementation(() => [invokingSender, otherSender]);

    const result = await getStreamStartHandler()(
      { sender: invokingSender },
      "streamTest",
      "senderTargeted",
      { token: "ok" },
    );

    await waitFor(
      () => streamEventsByKind(invokingSender, "progress").length === 1,
      "expected progress for invoking sender",
    );

    expect(invokingSender.send).toHaveBeenCalledWith("ipc:streamEvent", {
      streamId: result.streamId,
      kind: "progress",
      data: { step: 1 },
    });
    expect(otherSender.send).not.toHaveBeenCalled();
    expect(mockGetAllWebContents).not.toHaveBeenCalled();
  });
});
