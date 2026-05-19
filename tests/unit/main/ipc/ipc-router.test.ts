import { describe, expect, mock, test } from "bun:test";

// Mock electron before importing router.
// All mock.module calls must precede the dynamic imports that trigger them.
const mockHandle = mock((_channel: string, _handler: unknown) => {});
const mockOn = mock((_channel: string, _handler: unknown) => {});
const mockGetAllWebContents = mock(
  () => [] as { isDestroyed: () => boolean; send: (...a: unknown[]) => void }[],
);

// Suppress electron-log output — the router creates a logger at module load
// time, so we must stub electron-log/main before the router is imported.
mock.module("electron-log/main", () => ({
  default: {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    initialize: () => {},
    transports: {
      file: { resolvePathFn: undefined, level: "debug", format: undefined },
      console: { level: "info", format: undefined },
    },
  },
}));

mock.module("electron", () => ({
  ipcMain: { handle: mockHandle, on: mockOn },
  webContents: { getAllWebContents: mockGetAllWebContents },
  app: { getPath: () => "/tmp" },
}));

// Spy for the facade logger's error method — shared across every createLogger
// call so a test can assert the router logged a category:"bug" result.
const mockLogError = mock((..._args: unknown[]) => {});

// Stub shared/log/main so the router's lazy-require of createLogger never
// pulls in the real electron (which lacks `app` in the test environment).
// Absolute path without extension matches Bun's module resolution for require().
mock.module("/Users/kih/workspaces/areas/nexus-code/src/shared/log/main", () => ({
  createLogger: (_source: string) => ({
    error: mockLogError,
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
  initMainLogger: () => {},
}));

// Dynamic imports ensure mock.module stubs take effect before any
// module in the import graph is evaluated.
import { z } from "zod";

const { broadcast, register, setupRouter, validateArgs } = await import(
  "../../../../src/main/infra/ipc-router"
);
const { ipcErr, ipcOk, isIpcErrResult } = await import("../../../../src/shared/ipc/result");

setupRouter();

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

  test("router converts IpcValidationError from validateArgs into invalid-args IpcErrResult", async () => {
    // validateArgs throws IpcValidationError when args fail schema validation.
    // The ipc:call router catches it at the boundary and returns a typed IpcErrResult
    // so the renderer receives a value, not a rejection.
    register("hello-strict", {
      call: {
        echo: (args: unknown) => {
          // Existing handler style: destructure directly (validateArgs throws on failure).
          const { text } = validateArgs(z.object({ text: z.string() }), args);
          return text;
        },
      },
      listen: {},
    });

    const handler = getIpcCallHandler();
    const result = await handler({}, "hello-strict", "echo", { text: 123 });
    expect(isIpcErrResult(result)).toBe(true);
    expect((result as Record<string, unknown>).kind).toBe("invalid-args");
    expect((result as Record<string, unknown>).category).toBe("invalid-input");
    expect(typeof (result as Record<string, unknown>).message).toBe("string");
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

describe("ipc router — IpcResult passthrough", () => {
  test("handler returning ipcOk envelope is forwarded as-is (ok=true preserved)", async () => {
    register("result-ok-test", {
      call: { doWork: (_args: unknown) => ipcOk({ done: true }) },
      listen: {},
    });

    const handler = getIpcCallHandler();
    const result = await handler({}, "result-ok-test", "doWork", undefined);
    expect((result as Record<string, unknown>)["ok"]).toBe(true);
    expect((result as Record<string, unknown>)["value"]).toEqual({ done: true });
  });

  test("handler returning ipcErr envelope is forwarded as-is (ok=false + kind preserved)", async () => {
    register("result-err-test", {
      call: { findItem: (_args: unknown) => ipcErr("not-found", "Item missing") },
      listen: {},
    });

    const handler = getIpcCallHandler();
    const result = await handler({}, "result-err-test", "findItem", undefined);
    expect((result as Record<string, unknown>)["ok"]).toBe(false);
    expect((result as Record<string, unknown>)["kind"]).toBe("not-found");
    expect((result as Record<string, unknown>)["message"]).toBe("Item missing");
  });

  test("handler throwing still rejects (bug path unchanged)", async () => {
    register("result-throw-test", {
      call: {
        buggy: (_args: unknown) => {
          throw new Error("unexpected bug");
        },
      },
      listen: {},
    });

    const handler = getIpcCallHandler();
    await expect(handler({}, "result-throw-test", "buggy", undefined)).rejects.toThrow(
      "unexpected bug",
    );
  });

  test("router forwards category:bug result and does not re-throw it", async () => {
    register("result-bug-test", {
      call: {
        broken: (_args: unknown) =>
          ipcErr("internal-error", "invariant violated", { category: "bug" as const }),
      },
      listen: {},
    });

    mockLogError.mockClear();
    const handler = getIpcCallHandler();
    const result = await handler({}, "result-bug-test", "broken", undefined);
    expect(isIpcErrResult(result)).toBe(true);
    expect((result as Record<string, unknown>)["category"]).toBe("bug");
    // The "log line = real bug" invariant: a category:"bug" result must be
    // logged by the router even though it travels back as a value, not a throw.
    expect(mockLogError).toHaveBeenCalled();
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
