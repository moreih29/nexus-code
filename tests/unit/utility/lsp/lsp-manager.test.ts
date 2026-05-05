// Unit tests for the real LspManager — lazy spawn, idle shutdown, didClose
// lifecycle, multi-workspace timer isolation.
//
// We test the production class directly. The 30-minute IDLE_TIMEOUT_MS is
// configurable via the constructor (test-only opt). Tests use a 30 ms timeout
// and real setTimeout, then await ~80 ms — well within bun's scheduling
// jitter. The StdioLspAdapter is replaced with a fake via mock.module so we
// don't spawn real language-server binaries.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  CompletionItem,
  HoverResult,
  LocationResult,
  LspAdapter,
} from "../../../../src/utility/lsp-host/servers/stdio-lsp-adapter";

// ---------------------------------------------------------------------------
// Fake StdioLspAdapter — installed before the real LspManager is loaded
// ---------------------------------------------------------------------------

type DiagnosticsCallback = (uri: string, diags: unknown[]) => void;

interface FakeLspServerSpec {
  languageId: string;
}

const adapterInstances: FakeStdioLspAdapter[] = [];

class FakeStdioLspAdapter implements LspAdapter {
  readonly languageId: string;
  readonly workspaceId: string;
  readonly workspaceRootUri: string | null;
  started = false;
  disposed = false;
  readonly openedUris: string[] = [];
  readonly openedLanguageIds: string[] = [];
  readonly changedUris: string[] = [];
  readonly closedUris: string[] = [];
  readonly hoverUris: string[] = [];
  readonly definitionUris: string[] = [];
  readonly completionUris: string[] = [];

  constructor(
    spec: FakeLspServerSpec,
    workspaceId: string,
    workspaceRootUri: string | null,
    _onDiagnostics: DiagnosticsCallback,
  ) {
    this.languageId = spec.languageId;
    this.workspaceId = workspaceId;
    this.workspaceRootUri = workspaceRootUri;
    adapterInstances.push(this);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async didOpen(uri: string, languageId: string, _version: number, _text: string): Promise<void> {
    this.openedUris.push(uri);
    this.openedLanguageIds.push(languageId);
  }

  async didChange(uri: string, _version: number, _text: string): Promise<void> {
    this.changedUris.push(uri);
  }

  async didClose(uri: string): Promise<void> {
    this.closedUris.push(uri);
  }

  async hover(uri: string, _line: number, _char: number): Promise<HoverResult | null> {
    this.hoverUris.push(uri);
    return { contents: `fake hover ${this.workspaceId}` };
  }

  async definition(uri: string, _line: number, _char: number): Promise<LocationResult[]> {
    this.definitionUris.push(uri);
    return [{ uri, line: 0, character: 0 }];
  }

  async completion(uri: string, _line: number, _char: number): Promise<CompletionItem[]> {
    this.completionUris.push(uri);
    return [{ label: `fakeCompletion ${this.workspaceId}` }];
  }

  dispose(): void {
    this.disposed = true;
  }
}

mock.module("../../../../src/utility/lsp-host/servers/stdio-lsp-adapter", () => ({
  StdioLspAdapter: FakeStdioLspAdapter,
}));

import { LspManager } from "../../../../src/utility/lsp-host/lsp-manager";

type UriIndexEntry = { workspaceId: string; presetLanguageId: string };

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

function getUriIndex(manager: InstanceType<typeof LspManager>): Map<string, UriIndexEntry> {
  return (manager as unknown as { uriIndex: Map<string, UriIndexEntry> }).uriIndex;
}

function adapterFor(workspaceId: string): FakeStdioLspAdapter {
  const adapter = adapterInstances.find((instance) => instance.workspaceId === workspaceId);
  if (!adapter) {
    throw new Error(`adapter not found for ${workspaceId}`);
  }
  return adapter;
}

interface OpenFileOptions {
  workspaceRoot?: string;
  languageId?: string;
  version?: number;
  text?: string;
}

async function openFile(
  port: FakePort,
  workspaceId: string,
  uri: string,
  id: string | number = 1,
  opts: OpenFileOptions = {},
) {
  const expectedMessages = port.sent.length + 1;
  port.deliver(
    makeCallMsg(
      "didOpen",
      {
        workspaceId,
        workspaceRoot: opts.workspaceRoot ?? "/workspace",
        uri,
        languageId: opts.languageId ?? "typescript",
        version: opts.version ?? 1,
        text: opts.text ?? "",
      },
      id,
    ),
  );
  await port.waitForMessages(expectedMessages);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LspManager — lazy spawn", () => {
  beforeEach(() => {
    adapterInstances.length = 0;
  });

  test("no adapter is created until first didOpen", () => {
    const manager = new LspManager();
    const port = new FakePort();
    manager.attachPort(port);

    expect(adapterInstances.length).toBe(0);
    manager.disposeAll();
  });

  test("first didOpen spawns one adapter, started and tagged with workspace data", async () => {
    const manager = new LspManager();
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-1", "file:///test.ts");

    expect(adapterInstances.length).toBe(1);
    expect(adapterInstances[0].started).toBe(true);
    expect(adapterInstances[0].workspaceId).toBe("ws-1");
    expect(adapterInstances[0].languageId).toBe("typescript");
    expect(adapterInstances[0].workspaceRootUri).toBe("file:///workspace");
    expect(adapterInstances[0].openedUris).toEqual(["file:///test.ts"]);
    expect(adapterInstances[0].openedLanguageIds).toEqual(["typescript"]);
    manager.disposeAll();
  });

  test("second didOpen for the same workspace and language reuses the existing adapter", async () => {
    const manager = new LspManager();
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-1", "file:///a.ts", 1);
    await openFile(port, "ws-1", "file:///b.ts", 2);

    expect(adapterInstances.length).toBe(1);
    manager.disposeAll();
  });

  test("javascript didOpen uses the TypeScript preset adapter without spawning a duplicate", async () => {
    const manager = new LspManager();
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-js", "file:///a.ts", 1);
    await openFile(port, "ws-js", "file:///b.js", 2, { languageId: "javascript" });

    expect(adapterInstances.length).toBe(1);
    expect(adapterInstances[0].languageId).toBe("typescript");
    expect(adapterInstances[0].openedUris).toEqual(["file:///a.ts", "file:///b.js"]);
    expect(adapterInstances[0].openedLanguageIds).toEqual(["typescript", "javascript"]);
    expect(getUriIndex(manager).get("file:///b.js")).toEqual({
      workspaceId: "ws-js",
      presetLanguageId: "typescript",
    });

    port.deliver(makeCallMsg("hover", { uri: "file:///b.js", line: 0, character: 0 }, 3));
    await port.waitForMessages(3);
    port.deliver(makeCallMsg("completion", { uri: "file:///b.js", line: 0, character: 0 }, 4));
    await port.waitForMessages(4);

    expect(adapterInstances[0].hoverUris).toEqual(["file:///b.js"]);
    expect(adapterInstances[0].completionUris).toEqual(["file:///b.js"]);
    manager.disposeAll();
  });

  test("didOpen for unsupported language is a successful no-op", async () => {
    const manager = new LspManager();
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-unsupported", "file:///unsupported.rs", 1, {
      languageId: "nexus-unsupported-language",
    });

    expect(adapterInstances.length).toBe(0);
    expect(getUriIndex(manager).has("file:///unsupported.rs")).toBe(false);
    expect(port.sent[0]).toMatchObject({ type: "response", id: 1, result: null });
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
    adapterInstances.length = 0;
  });

  afterEach(() => {
    manager?.disposeAll();
  });

  test("idle timer disposes the server after idleTimeoutMs of inactivity", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-idle", "file:///i.ts");
    expect(adapterInstances[0].disposed).toBe(false);

    await delay(IDLE_WAIT_MS);

    expect(adapterInstances[0].disposed).toBe(true);
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
    expect(adapterInstances[0].disposed).toBe(false);

    // Now wait the full window without activity
    await delay(FAST_IDLE_MS + 30);
    expect(adapterInstances[0].disposed).toBe(true);
  });

  test("disposeAll shuts down servers immediately and cancels pending timers", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-dispose", "file:///d.ts");
    expect(adapterInstances[0].disposed).toBe(false);

    manager.disposeAll();
    expect(adapterInstances[0].disposed).toBe(true);
  });
});

describe("LspManager — didClose lifecycle", () => {
  let manager: InstanceType<typeof LspManager>;

  beforeEach(() => {
    adapterInstances.length = 0;
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

    expect(adapterInstances[0].closedUris).toEqual(["file:///c.ts"]);
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
    expect(adapterInstances[0].disposed).toBe(false);

    await delay(FAST_IDLE_MS + 30);
    expect(adapterInstances[0].disposed).toBe(true);
  });

  test("didClose for an unknown workspace is a no-op (still responds)", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    // No didOpen — no server exists. didClose should respond cleanly without throwing.
    port.deliver(makeCallMsg("didClose", { uri: "file:///nope.ts" }, 99));
    await port.waitForMessages(1);

    expect(adapterInstances.length).toBe(0);
    const resp = port.sent[0] as { type: string; id: number; result: unknown };
    expect(resp).toMatchObject({ type: "response", id: 99, result: null });
  });
});

describe("LspManager — URI-based routing", () => {
  let manager: InstanceType<typeof LspManager>;

  beforeEach(() => {
    adapterInstances.length = 0;
  });

  afterEach(() => {
    manager?.disposeAll();
  });

  test("same basename in two workspaces spawns separate adapters and routes by full URI", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-a", "file:///workspace-a/src/same.ts", 1, {
      workspaceRoot: "/workspace-a",
    });
    await openFile(port, "ws-b", "file:///workspace-b/src/same.ts", 2, {
      workspaceRoot: "/workspace b",
    });

    expect(adapterInstances).toHaveLength(2);
    expect(adapterFor("ws-a").workspaceRootUri).toBe("file:///workspace-a");
    expect(adapterFor("ws-b").workspaceRootUri).toBe("file:///workspace%20b");

    port.deliver(
      makeCallMsg("hover", { uri: "file:///workspace-b/src/same.ts", line: 0, character: 0 }, 3),
    );
    await port.waitForMessages(3);

    expect(adapterFor("ws-a").hoverUris).toEqual([]);
    expect(adapterFor("ws-b").hoverUris).toEqual(["file:///workspace-b/src/same.ts"]);
  });

  test("idle shutdown disposes only the expired workspace adapter", async () => {
    manager = new LspManager({ idleTimeoutMs: 200 });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-expire", "file:///expire.ts", 1);
    await delay(150);
    await openFile(port, "ws-live", "file:///live.ts", 2);

    await delay(100);

    expect(adapterFor("ws-expire").disposed).toBe(true);
    expect(adapterFor("ws-live").disposed).toBe(false);
    expect(getUriIndex(manager).has("file:///expire.ts")).toBe(false);
    expect(getUriIndex(manager).has("file:///live.ts")).toBe(true);
  });

  test("didChange dispatches to the adapter indexed for the uri", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-a", "file:///a.ts", 1);
    await openFile(port, "ws-b", "file:///b.ts", 2);

    port.deliver(makeCallMsg("didChange", { uri: "file:///b.ts", version: 2, text: "b" }, 3));
    await port.waitForMessages(3);

    expect(adapterFor("ws-a").changedUris).toEqual([]);
    expect(adapterFor("ws-b").changedUris).toEqual(["file:///b.ts"]);
  });

  test("didClose dispatches to the indexed adapter and removes only that uri", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-a", "file:///a.ts", 1);
    await openFile(port, "ws-b", "file:///b.ts", 2);

    port.deliver(makeCallMsg("didClose", { uri: "file:///b.ts" }, 3));
    await port.waitForMessages(3);

    expect(adapterFor("ws-a").closedUris).toEqual([]);
    expect(adapterFor("ws-b").closedUris).toEqual(["file:///b.ts"]);
    expect(getUriIndex(manager).has("file:///a.ts")).toBe(true);
    expect(getUriIndex(manager).has("file:///b.ts")).toBe(false);
  });

  test("hover, definition, and completion dispatch to the adapter indexed for the uri", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-a", "file:///a.ts", 1);
    await openFile(port, "ws-b", "file:///b.ts", 2);

    port.deliver(makeCallMsg("hover", { uri: "file:///b.ts", line: 0, character: 0 }, 3));
    await port.waitForMessages(3);
    port.deliver(makeCallMsg("definition", { uri: "file:///b.ts", line: 0, character: 0 }, 4));
    await port.waitForMessages(4);
    port.deliver(makeCallMsg("completion", { uri: "file:///b.ts", line: 0, character: 0 }, 5));
    await port.waitForMessages(5);

    expect(adapterFor("ws-a").hoverUris).toEqual([]);
    expect(adapterFor("ws-a").definitionUris).toEqual([]);
    expect(adapterFor("ws-a").completionUris).toEqual([]);
    expect(adapterFor("ws-b").hoverUris).toEqual(["file:///b.ts"]);
    expect(adapterFor("ws-b").definitionUris).toEqual(["file:///b.ts"]);
    expect(adapterFor("ws-b").completionUris).toEqual(["file:///b.ts"]);
    expect(port.sent[2]).toMatchObject({
      type: "response",
      id: 3,
      result: { contents: "fake hover ws-b" },
    });
    expect(port.sent[4]).toMatchObject({
      type: "response",
      id: 5,
      result: [{ label: "fakeCompletion ws-b" }],
    });
  });
});

describe("LspManager — URI index", () => {
  let manager: InstanceType<typeof LspManager>;

  beforeEach(() => {
    adapterInstances.length = 0;
  });

  afterEach(() => {
    manager?.disposeAll();
  });

  test("didOpen registers uri with workspaceId and languageId", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-index", "file:///indexed.ts", 1);

    expect(getUriIndex(manager).get("file:///indexed.ts")).toEqual({
      workspaceId: "ws-index",
      presetLanguageId: "typescript",
    });
  });

  test("didClose removes the uri from the index", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-index-close", "file:///closed.ts", 1);
    expect(getUriIndex(manager).has("file:///closed.ts")).toBe(true);

    port.deliver(makeCallMsg("didClose", { uri: "file:///closed.ts" }, 2));
    await port.waitForMessages(2);

    expect(getUriIndex(manager).has("file:///closed.ts")).toBe(false);
  });

  test("server shutdown removes index entries for that workspace", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-index-idle", "file:///idle.ts", 1);
    expect(getUriIndex(manager).has("file:///idle.ts")).toBe(true);

    await delay(IDLE_WAIT_MS);

    expect(adapterInstances[0].disposed).toBe(true);
    expect(getUriIndex(manager).has("file:///idle.ts")).toBe(false);
  });

  test("disposeAll removes all indexed uris", async () => {
    manager = new LspManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-index-a", "file:///a.ts", 1);
    await openFile(port, "ws-index-b", "file:///b.ts", 2);
    expect(getUriIndex(manager).size).toBe(2);

    manager.disposeAll();

    expect(getUriIndex(manager).size).toBe(0);
  });
});
