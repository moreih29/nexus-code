// Unit tests for the real LspManager — lazy spawn, idle shutdown, didClose
// lifecycle, multi-workspace timer isolation.
//
// We test the production class directly. The 30-minute IDLE_TIMEOUT_MS is
// configurable via the constructor (test-only opt). Tests use a 30 ms timeout
// and real setTimeout, then await ~80 ms — well within bun's scheduling
// jitter. The TypeScriptServer is replaced with a fake via mock.module so we
// don't spawn the real binary.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Fake TypeScriptServer — installed before the real LspManager is loaded
// ---------------------------------------------------------------------------

type DiagnosticsCallback = (uri: string, diags: unknown[]) => void;

const serverInstances: FakeTypeScriptServer[] = [];

class FakeTypeScriptServer {
  readonly workspaceId: string;
  started = false;
  disposed = false;
  readonly closedUris: string[] = [];

  constructor(workspaceId: string, _onDiagnostics: DiagnosticsCallback) {
    this.workspaceId = workspaceId;
    serverInstances.push(this);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async didOpen(
    _uri: string,
    _languageId: string,
    _version: number,
    _text: string,
  ): Promise<void> {}

  async didChange(_uri: string, _version: number, _text: string): Promise<void> {}

  async didClose(uri: string): Promise<void> {
    this.closedUris.push(uri);
  }

  async hover(_uri: string, _line: number, _char: number): Promise<{ contents: string } | null> {
    return { contents: "fake hover" };
  }

  async definition(_uri: string, _line: number, _char: number): Promise<unknown[]> {
    return [];
  }

  async completion(_uri: string, _line: number, _char: number): Promise<Array<{ label: string }>> {
    return [{ label: "fakeCompletion" }];
  }

  dispose(): void {
    this.disposed = true;
  }
}

mock.module("../../../../src/utility/lsp-host/servers/typescript", () => ({
  TypeScriptServer: FakeTypeScriptServer,
}));

import { LspManager } from "../../../../src/utility/lsp-host/lsp-manager";

// ---------------------------------------------------------------------------
// Fake MessagePort
// ---------------------------------------------------------------------------

class FakePort {
  private handlers: Array<(e: { data: unknown }) => void> = [];
  sent: unknown[] = [];
  private listeners: Array<() => void> = [];

  on(_event: "message", handler: (e: { data: unknown }) => void): void {
    this.handlers.push(handler);
  }

  start(): void {}

  postMessage(data: unknown): void {
    this.sent.push(data);
    const toNotify = this.listeners.splice(0);
    for (const fn of toNotify) fn();
  }

  deliver(data: unknown): void {
    for (const h of this.handlers) h({ data });
  }

  waitForMessages(count: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const bail = setTimeout(
        () => reject(new Error(`waitForMessages(${count}) timed out, got ${this.sent.length}`)),
        3000,
      );
      const check = () => {
        if (this.sent.length >= count) {
          clearTimeout(bail);
          resolve();
        } else {
          this.listeners.push(check);
        }
      };
      check();
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAST_IDLE_MS = 30;
// Conservative pad so the idle timer always fires before we assert.
// Bun's scheduling jitter on CI is in the low double-digit ms range.
const IDLE_WAIT_MS = 100;

function makeCallMsg(method: string, args: unknown, id: string | number = 1) {
  return { type: "call", id, method, args };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function openFile(
  port: FakePort,
  workspaceId: string,
  uri: string,
  id: string | number = 1,
) {
  port.deliver(
    makeCallMsg(
      "didOpen",
      { workspaceId, uri, languageId: "typescript", version: 1, text: "" },
      id,
    ),
  );
  await port.waitForMessages(port.sent.length + 1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LspManager — lazy spawn", () => {
  beforeEach(() => {
    serverInstances.length = 0;
  });

  test("no server is created until first didOpen", () => {
    const manager = new LspManager();
    const port = new FakePort();
    manager.attachPort(port);

    expect(serverInstances.length).toBe(0);
    manager.disposeAll();
  });

  test("first didOpen spawns one server, started and tagged with workspaceId", async () => {
    const manager = new LspManager();
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-1", "file:///test.ts");

    expect(serverInstances.length).toBe(1);
    expect(serverInstances[0].started).toBe(true);
    expect(serverInstances[0].workspaceId).toBe("ws-1");
    manager.disposeAll();
  });

  test("second didOpen for the same workspace reuses the existing server", async () => {
    const manager = new LspManager();
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-1", "file:///a.ts", 1);
    await openFile(port, "ws-1", "file:///b.ts", 2);

    expect(serverInstances.length).toBe(1);
    manager.disposeAll();
  });

  test("response message id matches the request id", async () => {
    const manager = new LspManager();
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-resp", "file:///r.ts", 42);

    const resp = port.sent[0] as { type: string; id: number };
    expect(resp).toMatchObject({ type: "response", id: 42 });
    manager.disposeAll();
  });
});

describe("LspManager — idle shutdown", () => {
  let manager: InstanceType<typeof LspManager>;

  beforeEach(() => {
    serverInstances.length = 0;
  });

  afterEach(() => {
    manager?.disposeAll();
  });

  test("idle timer disposes the server after idleTimeoutMs of inactivity", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-idle", "file:///i.ts");
    expect(serverInstances[0].disposed).toBe(false);

    await delay(IDLE_WAIT_MS);

    expect(serverInstances[0].disposed).toBe(true);
  });

  test("activity within the window resets the timer (server stays alive)", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-keepalive", "file:///k.ts", 1);

    // Just before the timer would fire, send activity → reset
    await delay(FAST_IDLE_MS / 2);
    port.deliver(makeCallMsg("hover", { uri: "file:///k.ts", line: 0, character: 0 }, 2));
    await port.waitForMessages(2);

    // Originally would have fired by now — should still be alive
    await delay(FAST_IDLE_MS / 2 + 5);
    expect(serverInstances[0].disposed).toBe(false);

    // Now wait the full window without activity
    await delay(FAST_IDLE_MS + 30);
    expect(serverInstances[0].disposed).toBe(true);
  });

  test("disposeAll shuts down servers immediately and cancels pending timers", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-dispose", "file:///d.ts");
    expect(serverInstances[0].disposed).toBe(false);

    manager.disposeAll();
    expect(serverInstances[0].disposed).toBe(true);
  });
});

describe("LspManager — didClose lifecycle", () => {
  let manager: InstanceType<typeof LspManager>;

  beforeEach(() => {
    serverInstances.length = 0;
  });

  afterEach(() => {
    manager?.disposeAll();
  });

  test("didClose forwards to the server with the same uri", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-close", "file:///c.ts", 1);

    port.deliver(makeCallMsg("didClose", { uri: "file:///c.ts" }, 2));
    await port.waitForMessages(2);

    expect(serverInstances[0].closedUris).toEqual(["file:///c.ts"]);
  });

  test("didClose resets the idle timer (server stays alive past original deadline)", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-close-reset", "file:///c.ts", 1);

    // Just before original timer fires, send didClose → reset
    await delay(FAST_IDLE_MS / 2);
    port.deliver(makeCallMsg("didClose", { uri: "file:///c.ts" }, 2));
    await port.waitForMessages(2);

    await delay(FAST_IDLE_MS / 2 + 5);
    expect(serverInstances[0].disposed).toBe(false);

    await delay(FAST_IDLE_MS + 30);
    expect(serverInstances[0].disposed).toBe(true);
  });

  test("didClose for an unknown workspace is a no-op (still responds)", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    // No didOpen — no server exists. didClose should respond cleanly without throwing.
    port.deliver(makeCallMsg("didClose", { uri: "file:///nope.ts" }, 99));
    await port.waitForMessages(1);

    expect(serverInstances.length).toBe(0);
    const resp = port.sent[0] as { type: string; id: number; result: unknown };
    expect(resp).toMatchObject({ type: "response", id: 99, result: null });
  });
});
