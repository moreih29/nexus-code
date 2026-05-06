import { describe, expect, mock, test } from "bun:test";

// Mock electron before importing router.
// Bun mock.module must be called before the import that uses it.
const mockHandle = mock((_channel: string, _handler: unknown) => {});
const mockOn = mock((_channel: string, _handler: unknown) => {});
const mockGetAllWebContents = mock(
  () => [] as { isDestroyed: () => boolean; send: (...a: unknown[]) => void }[],
);

mock.module("electron", () => ({
  ipcMain: {
    handle: mockHandle,
    on: mockOn,
  },
  webContents: {
    getAllWebContents: mockGetAllWebContents,
  },
}));

import { z } from "zod";
import { broadcast, register, setupRouter, validateArgs } from "../../../../src/main/ipc/router";

// Wire up the handler by calling setupRouter() once
setupRouter();

// Retrieve the handler that was passed to ipcMain.handle('ipc:call', ...)
type IpcHandler = (
  event: { sender?: { id?: number } },
  channelName: string,
  method: string,
  args: unknown,
  requestId?: unknown,
) => Promise<unknown>;

type CancelHandler = (event: { sender?: { id?: number } }, requestId: unknown) => void;

function getIpcCallHandler(): IpcHandler {
  const calls = mockHandle.mock.calls as [string, IpcHandler][];
  const entry = calls.find(([ch]) => ch === "ipc:call");
  if (!entry) throw new Error("ipcMain.handle('ipc:call') was not called");
  return entry[1];
}

function getIpcCancelHandler(): CancelHandler {
  const calls = mockOn.mock.calls as [string, CancelHandler][];
  const entry = calls.find(([ch]) => ch === "ipc:cancel");
  if (!entry) throw new Error("ipcMain.on('ipc:cancel') was not called");
  return entry[1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ipc router — ping/pong round trip", () => {
  test("ping returns pong", async () => {
    register("hello-test", {
      call: {
        ping: (args: unknown) => {
          validateArgs(z.void(), args);
          return "pong" as const;
        },
      },
      listen: {},
    });

    const handler = getIpcCallHandler();
    const result = await handler({}, "hello-test", "ping", undefined);
    expect(result).toBe("pong");
  });

  test("rejects when args fail zod parse", async () => {
    register("hello-strict", {
      call: {
        echo: (args: unknown) => {
          validateArgs(z.object({ text: z.string() }), args);
          return (args as { text: string }).text;
        },
      },
      listen: {},
    });

    const handler = getIpcCallHandler();
    await expect(handler({}, "hello-strict", "echo", { text: 123 })).rejects.toThrow(
      "ipc:call — invalid args",
    );
  });

  test("ipc:cancel aborts the matching in-flight call context signal", async () => {
    let seenSignal: AbortSignal | undefined;
    let resolveCall: ((value: string) => void) | undefined;

    register("hello-cancel", {
      call: {
        wait: (_args, ctx) => {
          seenSignal = ctx?.signal;
          return new Promise<string>((resolve) => {
            resolveCall = resolve;
          });
        },
      },
      listen: {},
    });

    const handler = getIpcCallHandler();
    const cancel = getIpcCancelHandler();
    const event = { sender: { id: 7 } };
    const pending = handler(event, "hello-cancel", "wait", undefined, "req-1");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seenSignal?.aborted).toBe(false);

    cancel(event, "req-1");
    expect(seenSignal?.aborted).toBe(true);

    resolveCall?.("done");
    await expect(pending).resolves.toBe("done");
  });
});

describe("ipc router — broadcast", () => {
  test("sends ipc:event to all webContents", () => {
    const mockSend = mock((..._args: unknown[]) => {});
    mockGetAllWebContents.mockImplementation(() => [{ isDestroyed: () => false, send: mockSend }]);

    broadcast("hello", "tick", 1);

    expect(mockSend).toHaveBeenCalledWith("ipc:event", "hello", "tick", 1);
  });
});
