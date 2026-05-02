import { describe, expect, test, mock } from "bun:test";

// Mock electron before importing router.
// Bun mock.module must be called before the import that uses it.
const mockHandle = mock((_channel: string, _handler: unknown) => {});
const mockGetAllWebContents = mock(() => [] as { isDestroyed: () => boolean; send: (...a: unknown[]) => void }[]);

mock.module("electron", () => ({
  ipcMain: {
    handle: mockHandle,
  },
  webContents: {
    getAllWebContents: mockGetAllWebContents,
  },
}));

import { register, setupRouter, broadcast, validateArgs } from "../../src/main/ipc/router";
import { z } from "zod";

// Wire up the handler by calling setupRouter() once
setupRouter();

// Retrieve the handler that was passed to ipcMain.handle('ipc:call', ...)
type IpcHandler = (
  event: unknown,
  channelName: string,
  method: string,
  args: unknown
) => Promise<unknown>;

function getIpcCallHandler(): IpcHandler {
  const calls = mockHandle.mock.calls as [string, IpcHandler][];
  const entry = calls.find(([ch]) => ch === "ipc:call");
  if (!entry) throw new Error("ipcMain.handle('ipc:call') was not called");
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
      "ipc:call — invalid args"
    );
  });
});

describe("ipc router — broadcast", () => {
  test("sends ipc:event to all webContents", () => {
    const mockSend = mock((..._args: unknown[]) => {});
    mockGetAllWebContents.mockImplementation(() => [
      { isDestroyed: () => false, send: mockSend },
    ]);

    broadcast("hello", "tick", 1);

    expect(mockSend).toHaveBeenCalledWith("ipc:event", "hello", "tick", 1);
  });
});
