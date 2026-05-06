/**
 * Integration: IPC round-trip through router + channel + zod validation.
 *
 * Uses a fake ipcMain/webContents harness so the test runs without Electron.
 * Exercises the full path: register → validateArgs (zod) → call handler →
 * broadcast → fake listener.
 *
 * Monaco + xterm renderer integration is deferred to T13 (manual scenario).
 */

import { beforeAll, describe, expect, it, mock } from "bun:test";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Fake Electron harness
// ---------------------------------------------------------------------------

type IpcCallHandler = (
  event: { sender?: { id?: number } },
  channelName: string,
  method: string,
  args: unknown,
  requestId?: unknown,
) => Promise<unknown>;

let capturedIpcCallHandler: IpcCallHandler | null = null;

const fakeIpcMainHandle = mock((channel: string, handler: IpcCallHandler) => {
  if (channel === "ipc:call") {
    capturedIpcCallHandler = handler;
  }
});
const fakeIpcMainOn = mock((_channel: string, _handler: unknown) => {});

const fakeListeners: { isDestroyed: () => boolean; send: ReturnType<typeof mock> }[] = [];

const fakeGetAllWebContents = mock(() => fakeListeners);

mock.module("electron", () => ({
  ipcMain: {
    handle: fakeIpcMainHandle,
    on: fakeIpcMainOn,
  },
  webContents: {
    getAllWebContents: fakeGetAllWebContents,
  },
}));

import { broadcast, register, setupRouter, validateArgs } from "../../src/main/ipc/router";

// ---------------------------------------------------------------------------
// Wire up router once — registers the ipcMain.handle('ipc:call') handler.
// ---------------------------------------------------------------------------

beforeAll(() => {
  setupRouter();
});

function getHandler(): IpcCallHandler {
  if (!capturedIpcCallHandler) {
    throw new Error("setupRouter() did not register the ipc:call handler");
  }
  return capturedIpcCallHandler;
}

// ---------------------------------------------------------------------------
// Test channel: integration-echo
// Simulates a simple call+zod-validated channel registered from main.
// ---------------------------------------------------------------------------

describe("ipc round-trip — call.echo with zod validation", () => {
  beforeAll(() => {
    const echoArgsSchema = z.object({ val: z.string() });

    register("integration-echo", {
      call: {
        echo: (args: unknown) => {
          const { val } = validateArgs(echoArgsSchema, args);
          return val.toUpperCase();
        },
      },
      listen: {
        result: {},
      },
    });
  });

  it("call.echo returns uppercased value", async () => {
    const handler = getHandler();
    const result = await handler({}, "integration-echo", "echo", { val: "hello" });
    expect(result).toBe("HELLO");
  });

  it("call.echo rejects invalid args — missing val field", async () => {
    const handler = getHandler();
    await expect(handler({}, "integration-echo", "echo", { notVal: 123 })).rejects.toThrow(
      "ipc:call — invalid args",
    );
  });

  it("call.echo rejects invalid args — val is not a string", async () => {
    const handler = getHandler();
    await expect(handler({}, "integration-echo", "echo", { val: 42 })).rejects.toThrow(
      "ipc:call — invalid args",
    );
  });
});

// ---------------------------------------------------------------------------
// Test channel: integration-broadcast
// Simulates listen.changed broadcast reaching a fake webContents.
// ---------------------------------------------------------------------------

describe("ipc round-trip — broadcast reaches listener", () => {
  it("broadcast sends ipc:event to all non-destroyed webContents", () => {
    const mockSend = mock((..._args: unknown[]) => {});
    fakeListeners.splice(0, fakeListeners.length, {
      isDestroyed: () => false,
      send: mockSend,
    });

    broadcast("integration-echo", "result", { val: "HELLO" });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [channel, channelName, event, args] = mockSend.mock.calls[0] as [
      string,
      string,
      string,
      unknown,
    ];
    expect(channel).toBe("ipc:event");
    expect(channelName).toBe("integration-echo");
    expect(event).toBe("result");
    expect(args).toEqual({ val: "HELLO" });

    fakeListeners.splice(0, fakeListeners.length);
  });

  it("broadcast skips destroyed webContents", () => {
    const mockSend = mock((..._args: unknown[]) => {});
    fakeListeners.splice(0, fakeListeners.length, {
      isDestroyed: () => true,
      send: mockSend,
    });

    broadcast("integration-echo", "result", { val: "SKIP" });

    expect(mockSend).not.toHaveBeenCalled();

    fakeListeners.splice(0, fakeListeners.length);
  });
});

// ---------------------------------------------------------------------------
// Test channel: unknown channel / unknown method errors
// ---------------------------------------------------------------------------

describe("ipc round-trip — routing errors", () => {
  it("rejects calls to an unknown channel", async () => {
    const handler = getHandler();
    await expect(handler({}, "no-such-channel", "someMethod", {})).rejects.toThrow(
      "unknown channel: no-such-channel",
    );
  });

  it("rejects calls to an unknown method on a registered channel", async () => {
    const handler = getHandler();
    await expect(handler({}, "integration-echo", "noSuchMethod", {})).rejects.toThrow(
      "unknown method: integration-echo.noSuchMethod",
    );
  });
});
