/**
 * Integration: IPC round-trip through router + channel + zod validation.
 *
 * Uses a fake ipcMain/webContents harness so the test runs without Electron.
 * Exercises the full path: register -> validateArgs (zod) -> call handler ->
 * broadcast -> fake listener.
 *
 * Monaco + xterm renderer integration requires a browser-level manual scenario.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { FileMatch, SearchComplete } from "../../../src/shared/search/types";
import {
  createIpcPair,
  mockGetAllWebContents,
  mockIpcMain,
  resetInMemoryIpc,
} from "../../helpers/ipc-pair";
import { mainErrorMock } from "../../log-test-spies";

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

const fakeListeners: {
  id?: number;
  isDestroyed: () => boolean;
  send: ReturnType<typeof mock>;
  once?: (event: string, listener: () => void) => void;
}[] = [];

const fakeGetAllWebContents = () => [...fakeListeners, ...mockGetAllWebContents()];

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

let userData = "/tmp";
mock.module("electron", () => ({
  ipcMain: mockIpcMain,
  webContents: { getAllWebContents: fakeGetAllWebContents },
  app: { getPath: () => userData, isPackaged: false, getVersion: () => "0.1.0" },
  nativeImage: {},
  shell: {},
  systemPreferences: {},
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "test",
    decryptStringAsync: async (bytes: Buffer) => ({ result: bytes.toString("utf8") }),
  },
}));

const { broadcast, excludeFromBroadcast, register, setupRouter, validateArgs } = await import(
  "../../../src/main/infra/ipc-router"
);
const { registerRemoteChannel } = await import("../../../src/main/features/remote");
const { remoteServer } = await import("../../../src/main/features/remote/server");
const { isIpcErrResult } = await import("../../../src/shared/ipc/result");

// ---------------------------------------------------------------------------
// Both the handler-level and renderer-lifetime cases use the same router.
beforeEach(() => {
  resetInMemoryIpc();
  setupRouter();
});
afterEach(resetInMemoryIpc);

function getHandler(): IpcCallHandler {
  const handler = mockIpcMain.handle.mock.calls.find(([channel]) => channel === "ipc:call")?.[1];
  if (!handler) {
    throw new Error("setupRouter() did not register the ipc:call handler");
  }
  return handler as unknown as IpcCallHandler;
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
          // validateArgs throws IpcValidationError on schema failure.
          // The router catches it at the IPC boundary and converts it into an
          // IpcErrResult<"invalid-args"> so the renderer gets a typed result.
          const { val } = validateArgs(echoArgsSchema, args);
          return val.toUpperCase();
        },
      },
      listen: {
        result: {},
      },
    });
  });

  it("call.echo returns invalid-args IpcErrResult for missing val field", async () => {
    const handler = getHandler();
    const result = await handler({}, "integration-echo", "echo", { notVal: 123 });
    expect(isIpcErrResult(result)).toBe(true);
    expect((result as Record<string, unknown>).kind).toBe("invalid-args");
    expect((result as Record<string, unknown>).category).toBe("invalid-input");
    expect((result as Record<string, unknown>).message).toBe(
      `ipc:call — invalid args: ${JSON.stringify(
        [
          {
            code: "invalid_type",
            expected: "string",
            received: "undefined",
            path: ["val"],
            message: "Required",
          },
        ],
        null,
        2,
      )}`,
    );
  });

  it("call.echo returns invalid-args IpcErrResult when val is not a string", async () => {
    const handler = getHandler();
    const result = await handler({}, "integration-echo", "echo", { val: 42 });
    expect(isIpcErrResult(result)).toBe(true);
    expect((result as Record<string, unknown>).kind).toBe("invalid-args");
    expect((result as Record<string, unknown>).category).toBe("invalid-input");
  });
});

// ---------------------------------------------------------------------------
// Test channel: integration-broadcast
// Simulates listen.changed broadcast reaching a fake webContents.
// ---------------------------------------------------------------------------

describe("ipc round-trip — broadcast reaches listener", () => {
  // Regression: broadcasts (terminal output, OAuth redirects, SSH prompts)
  // went to every WebContents, including embedded browser tabs and popups.
  it("broadcast skips WebContents excluded as third-party pages", () => {
    const appSend = mock((..._args: unknown[]) => {});
    const tabSend = mock((..._args: unknown[]) => {});
    let onDestroyed: (() => void) | null = null;
    const tab = {
      id: 902,
      isDestroyed: () => false,
      send: tabSend,
      once: (_event: string, listener: () => void) => {
        onDestroyed = listener;
      },
    };
    fakeListeners.splice(
      0,
      fakeListeners.length,
      { id: 901, isDestroyed: () => false, send: appSend },
      tab,
    );

    excludeFromBroadcast(tab as never);
    broadcast("integration-echo", "result", { val: "PTY" });

    expect(appSend).toHaveBeenCalledTimes(1);
    expect(tabSend).not.toHaveBeenCalled();
    expect(onDestroyed).not.toBeNull();

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
  it("returns invalid input for an unknown channel or method", async () => {
    const handler = getHandler();
    for (const [channel, method] of [
      ["no-such-channel", "someMethod"],
      ["integration-echo", "noSuchMethod"],
      ["integration-echo", "constructor"],
    ]) {
      expect(await handler({}, channel, method, {})).toMatchObject({
        ok: false,
        kind: "invalid-args",
        category: "invalid-input",
      });
    }
  });

  it("returns a sanitized bug envelope and masks secrets in the correlated exception log", async () => {
    const detail = "unexpected internal failure /private/source";
    register("integration-bug", {
      call: {
        work: () =>
          Promise.reject(
            new Error(`${detail} Authorization: Basic auth-fixture APP_KEY="env fixture"`),
          ),
      },
      listen: {},
    });
    const start = mainErrorMock.mock.calls.length;
    const result = await getHandler()({}, "integration-bug", "work", {});
    expect(result).toMatchObject({
      ok: false,
      kind: "bug",
      category: "bug",
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain(detail);
    const messages = mainErrorMock.mock.calls
      .slice(start)
      .map(([message]) => message)
      .join("\n");
    expect(messages).not.toContain("auth-fixture");
    expect(messages).not.toContain("env fixture");
    expect(mainErrorMock.mock.calls.slice(start)).toEqual([
      [
        expect.stringContaining(detail),
        { correlationId: (result as { correlationId: string }).correlationId },
      ],
    ]);
  });

  it("maps workspace activation and connection failures through the call envelope", async () => {
    const { registerWorkspaceChannel } = await import("../../../src/main/features/workspace/ipc");
    const id = "123e4567-e89b-12d3-a456-426614174000";
    let name: string | null = "Workspace";
    let failure: unknown;
    const run = async () => {
      throw failure;
    };
    registerWorkspaceChannel({ getName: () => name, activate: run, connect: run } as never);
    const invoke = (method: string) => getHandler()({}, "workspace", method, { id });

    name = null;
    expect(await invoke("activate")).toMatchObject({
      ok: false,
      kind: "not-found",
      category: "failed",
    });
    name = "Workspace";
    failure = Object.assign(new Error("raw SSH detail"), { code: "ssh.auth-failed" });
    expect(await invoke("connect")).toMatchObject({
      ok: false,
      kind: "connection-failed",
      category: "failed",
      domain: "ssh",
      code: "ssh.auth-failed",
      message: "SSH authentication failed",
    });
    failure = Object.assign(new Error("interrupted"), { name: "AbortError" });
    expect(await invoke("activate")).toMatchObject({
      ok: false,
      kind: "cancelled",
      category: "cancelled",
    });
    failure = new Error("unexpected connection internals");
    expect(await invoke("connect")).toMatchObject({
      ok: false,
      kind: "bug",
      correlationId: expect.any(String),
      message: "An unexpected error occurred",
    });
  });

  it("returns a recoverable SSH browse error after the session closes", async () => {
    const { browseSessionHandler } = await import("../../../src/main/features/ssh/ipc");
    const { SshBrowseSessionRegistry } = await import(
      "../../../src/main/features/ssh/browse-session-registry"
    );
    const registry = new SshBrowseSessionRegistry();
    const sessionId = registry.register({ dispose: () => {} } as never, null);
    registry.close(sessionId);
    register("integration-browse", { call: { list: browseSessionHandler(registry) }, listen: {} });
    try {
      expect(
        await getHandler()({}, "integration-browse", "list", { sessionId, path: "/" }),
      ).toMatchObject({
        ok: false,
        kind: "session-expired",
        category: "failed",
        domain: "ssh",
        code: "ssh.session-expired",
      });
    } finally {
      registry.dispose();
    }
  });

  it("returns typed transport failures from FS watch and write provider startup", async () => {
    const { watchHandler } = await import("../../../src/main/features/fs/ipc/watch-handlers");
    const { writeFileHandler } = await import("../../../src/main/features/fs/ipc/write-handlers");
    const offline = async () => {
      throw Object.assign(new Error("timed out"), { code: "transport.timeout" });
    };
    register("integration-fs-transport", {
      call: {
        watch: watchHandler({ watch: offline } as never),
        write: writeFileHandler({ getFs: offline } as never),
      },
      listen: {},
    });
    const args = {
      workspaceId: "123e4567-e89b-12d3-a456-426614174000",
      relPath: "a",
      content: "new",
      expected: { exists: false },
    };
    for (const method of ["watch", "write"]) {
      expect(await getHandler()({}, "integration-fs-transport", method, args)).toMatchObject({
        ok: false,
        category: "failed",
        code: "transport.timeout",
      });
    }
  });
});

describe("remote shutdown", () => {
  it("stops the temporary relay when the registered remote feature shuts down", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-remote-dispose-"));
    userData = directory;
    const ticket = Promise.withResolvers<AbortSignal | null | undefined>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      if (new URL(String(url)).pathname === "/relay/ticket") {
        ticket.resolve(options?.signal);
        return new Promise<Response>(() => {});
      }
      return new Response(null, { status: 404 });
    });
    try {
      await writeFile(
        path.join(directory, "remote-account.bin"),
        JSON.stringify({
          server: remoteServer(process.env, false),
          token: "fixture-token",
          user: { id: "u1", name: "Test", email: "test@example.test" },
          device: { id: "d1", name: "Test", platform: "darwin" },
        }),
      );
      const off = { get: () => false, set: () => {} };
      const remote = await registerRemoteChannel({
        services: () => null,
        allowControl: off,
        allowTerminal: off,
        agents: { get: () => "deny", set: () => {} },
      });
      try {
        const start = getHandler()({}, "remote", "pairStart", undefined);
        const signal = await ticket.promise;
        await start;
        remote.dispose();
        expect(signal?.aborted).toBe(true);
      } finally {
        await getHandler()({}, "remote", "pairStop", undefined);
        remote.dispose();
      }
    } finally {
      fetch.mockRestore();
      userData = "/tmp";
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("destroying one renderer aborts its pending call and leaves another renderer's call alone", async () => {
  const first = Promise.withResolvers<AbortSignal>();
  const second = Promise.withResolvers<AbortSignal>();
  const finish = Promise.withResolvers<void>();
  register("call-lifetime", {
    call: {
      wait: async (args, ctx) => {
        (args === "first" ? first : second).resolve(ctx!.signal!);
        await finish.promise;
      },
    },
    listen: {},
  });
  const pair = createIpcPair();
  const other = createIpcPair();
  const pending = pair.window.ipc.call("call-lifetime", "wait", "first", "req");
  const unrelated = other.window.ipc.call("call-lifetime", "wait", "second", "req");
  try {
    const [signal, otherSignal] = await Promise.all([first.promise, second.promise]);
    pair.sender.destroy();
    expect(signal.aborted).toBe(true);
    expect(otherSignal.aborted).toBe(false);
  } finally {
    finish.resolve();
    await Promise.all([pending, unrelated]);
  }
});

test("a stream opened after its renderer dies is closed without starting it", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const complete = { filesScanned: 0, matchesFound: 0, limitHit: false, elapsedMs: 0 };
  const generator = Promise.withResolvers<AsyncGenerator<FileMatch[], SearchComplete>>();
  const iterator = Object.assign(
    (async function* () {
      yield [] as FileMatch[];
      return complete;
    })(),
    { return: mock(async () => ({ done: true as const, value: complete })) },
  );
  register("fs", {
    call: {},
    listen: {},
    stream: {
      searchText: async (_args, ctx) => {
        entered.resolve(ctx.signal);
        return generator.promise;
      },
    },
  });
  const pair = createIpcPair();
  await pair.window.ipc.streamStart("fs", "searchText", {
    workspaceId: "123e4567-e89b-12d3-a456-426614174000",
    query: { pattern: "needle" },
  });
  const signal = await entered.promise;
  pair.sender.destroy();

  generator.resolve(iterator);
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(signal.aborted).toBe(true);
  expect(iterator.return).toHaveBeenCalledTimes(1);
  expect(pair.sender.streamEvents).toEqual([]);
});

test("a call without a caller ID is cancelled on renderer destruction while a durable save finishes", async () => {
  const signals = new Map<string, AbortSignal | undefined>();
  const finish = Promise.withResolvers<void>();
  register("owner-lifetime", {
    keepOnRendererClose: ["save"],
    call: {
      load: async (_args, ctx) => {
        signals.set("load", ctx?.signal);
        await finish.promise;
      },
      save: async (_args, ctx) => {
        signals.set("save", ctx?.signal);
        await finish.promise;
        return "saved";
      },
    },
    listen: {},
  });
  const pair = createIpcPair();
  const load = pair.window.ipc.call("owner-lifetime", "load", undefined);
  const save = pair.window.ipc.call("owner-lifetime", "save", undefined);
  try {
    pair.sender.destroy();
    expect(signals.get("load")?.aborted).toBe(true);
    expect(signals.get("save")?.aborted).toBe(false);
  } finally {
    finish.resolve();
    await load;
    expect(await save).toBe("saved");
  }
});

test("the pre-cancellation cache retains only the newest 1024 request IDs", async () => {
  register("cancel-limit", {
    call: { check: (_args, ctx) => ctx?.signal?.aborted },
    listen: {},
  });
  const pair = createIpcPair();
  for (let i = 0; i <= 1024; i += 1) pair.window.ipc.cancel(`limit-${i}`);
  expect(await pair.window.ipc.call("cancel-limit", "check", undefined, "limit-0")).toBe(false);
  expect(await pair.window.ipc.call("cancel-limit", "check", undefined, "limit-1")).toBe(true);
  expect(await pair.window.ipc.call("cancel-limit", "check", undefined, "limit-1024")).toBe(true);
  await Promise.all(
    Array.from({ length: 1022 }, (_, index) =>
      pair.window.ipc.call("cancel-limit", "check", undefined, `limit-${index + 2}`),
    ),
  );
});

test("unknown stream channels and methods return an invalid-input result", async () => {
  register("fs", { call: {}, listen: {} });
  const pair = createIpcPair();
  for (const [channel, method] of [
    ["missing", "searchText"],
    ["fs", "constructor"],
  ] as const) {
    await expect(pair.window.ipc.streamStart(channel, method, undefined)).resolves.toMatchObject({
      ok: false,
      kind: "invalid-args",
      category: "invalid-input",
    });
  }
  expect(pair.sender.streamEvents).toEqual([]);
});
