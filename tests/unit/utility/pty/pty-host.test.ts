import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Fake port / process / channel
// ---------------------------------------------------------------------------

type MessageHandler = (event: { data: unknown }) => void;

class FakePort {
  private handlers: MessageHandler[] = [];
  readonly sent: unknown[] = [];
  started = false;
  closed = false;

  on(_event: "message", handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  postMessage(data: unknown, _transfer?: unknown[]): void {
    this.sent.push(data);
  }

  // Test helper — deliver a message to all registered handlers
  deliver(data: unknown): void {
    for (const h of this.handlers) {
      h({ data });
    }
  }
}

// The channel created by the last `new electron.MessageChannelMain()` call
let lastChannel: { port1: FakePort; port2: FakePort } = {
  port1: new FakePort(),
  port2: new FakePort(),
};

// The process created by the last `electron.utilityProcess.fork()` call.
// Initialised in the test bootstrap before any read.
let lastProc: FakeProc = null!;

class FakeProc {
  stdout = { on: mock((_event: string, _handler: unknown) => {}) };
  stderr = { on: mock((_event: string, _handler: unknown) => {}) };
  private exitHandlers: Array<(code: number | null) => void> = [];
  readonly posted: unknown[] = [];
  killed = false;

  once(_event: "exit", handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  postMessage(data: unknown, _transfer?: unknown[]): void {
    this.posted.push(data);
  }

  kill(): void {
    this.killed = true;
  }

  simulateExit(code: number | null): void {
    for (const h of this.exitHandlers) h(code);
    this.exitHandlers = [];
  }
}

// ---------------------------------------------------------------------------
// Mock electron before importing ptyHost
// ---------------------------------------------------------------------------

mock.module("electron", () => ({
  app: {
    getAppPath: () => "/fake/app",
  },
  utilityProcess: {
    fork: (_entry: string, _args: string[], _opts: object) => {
      lastProc = new FakeProc();
      return lastProc;
    },
  },
  MessageChannelMain: class {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      lastChannel = this as unknown as { port1: FakePort; port2: FakePort };
    }
  },
}));

import { startPtyHost } from "../../../../src/main/hosts/pty-host";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startPtyHost — basic API shape", () => {
  test("isAlive returns true before dispose, false after", () => {
    const handle = startPtyHost();
    expect(handle.isAlive()).toBe(true);
    handle.dispose();
    expect(handle.isAlive()).toBe(false);
  });
});

describe("startPtyHost — event forwarding via port", () => {
  test("on('data') callback receives data events delivered on port1", () => {
    const received: unknown[] = [];
    const handle = startPtyHost();
    const port = lastChannel.port1;

    handle.on("data", (args) => received.push(args));
    port.deliver({ type: "data", tabId: "tab-1", chunk: "hello" });

    expect(received.length).toBe(1);
    expect((received[0] as { chunk: string }).chunk).toBe("hello");
    handle.dispose();
  });

  test("on('exit') callback receives exit events delivered on port1", () => {
    const exits: unknown[] = [];
    const handle = startPtyHost();
    const port = lastChannel.port1;

    handle.on("exit", (args) => exits.push(args));
    port.deliver({ type: "exit", tabId: "tab-1", code: 0 });

    expect(exits.length).toBe(1);
    expect((exits[0] as { code: number }).code).toBe(0);
    handle.dispose();
  });

  test("unsubscribe removes handler so no further events arrive", () => {
    const received: unknown[] = [];
    const handle = startPtyHost();
    const port = lastChannel.port1;

    const unsub = handle.on("data", (args) => received.push(args));
    port.deliver({ type: "data", tabId: "tab-1", chunk: "first" });
    unsub();
    port.deliver({ type: "data", tabId: "tab-1", chunk: "second" });

    expect(received.length).toBe(1);
    handle.dispose();
  });
});

describe("startPtyHost — call forwarding to port", () => {
  test("call('write') posts write message to port1", async () => {
    const handle = startPtyHost();
    const port = lastChannel.port1;

    await handle.call("write", { tabId: "tab-1", data: "hello\n" });

    const msg = port.sent.find((m) => (m as { type: string }).type === "write");
    expect(msg).toBeDefined();
    expect((msg as { data: string }).data).toBe("hello\n");
    handle.dispose();
  });

  test("call('kill') posts kill message to port1", async () => {
    const handle = startPtyHost();
    const port = lastChannel.port1;

    await handle.call("kill", { tabId: "tab-1" });

    const msg = port.sent.find((m) => (m as { type: string }).type === "kill");
    expect(msg).toBeDefined();
    handle.dispose();
  });

  test("call('spawn') resolves when 'spawned' message is delivered on port1", async () => {
    const handle = startPtyHost();
    const port = lastChannel.port1;

    const spawnPromise = handle.call("spawn", {
      tabId: "tab-spawn-1",
      cwd: "/",
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
    });

    port.deliver({ type: "spawned", tabId: "tab-spawn-1", pid: 9999 });

    const result = await spawnPromise;
    expect((result as { pid: number }).pid).toBe(9999);
    handle.dispose();
  });

  test("call('spawn') rejects when 'exit' arrives before 'spawned'", async () => {
    const handle = startPtyHost();
    const port = lastChannel.port1;

    const spawnPromise = handle.call("spawn", {
      tabId: "tab-spawn-fail",
      cwd: "/",
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
    });

    port.deliver({ type: "exit", tabId: "tab-spawn-fail", code: 1 });

    await expect(spawnPromise).rejects.toThrow();
    handle.dispose();
  });
});

describe("startPtyHost — onExit restart", () => {
  test("proc is restarted after unexpected exit and new channel is created", () => {
    const handle = startPtyHost();
    const originalProc = lastProc;

    // Simulate unexpected exit
    originalProc.simulateExit(1);

    // A new proc and new channel should have been created
    expect(lastProc).not.toBe(originalProc);
    expect(lastChannel.port1).toBeDefined();
    expect(lastChannel.port1.started).toBe(true);

    handle.dispose();
  });

  test("no restart after dispose", () => {
    const handle = startPtyHost();
    const originalProc = lastProc;
    handle.dispose();

    originalProc.simulateExit(1);

    // proc should NOT have been replaced because disposed flag stops restart
    expect(lastProc).toBe(originalProc);
  });
});
