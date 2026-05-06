// Unit tests for the real LspManager — lazy spawn, idle shutdown, didClose
// lifecycle, multi-workspace timer isolation.
//
// We test the production class directly. The 30-minute IDLE_TIMEOUT_MS is
// configurable via the constructor (test-only opt). Tests use a 30 ms timeout
// and real setTimeout, then await ~80 ms — well within bun's scheduling
// jitter. The adapter factory is replaced with a fake so we don't spawn real
// language-server binaries.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LspAdapter } from "../../../../src/utility/lsp-host/servers/stdio-lsp-adapter";
import { LspManager, type LspManagerOpts } from "../../../../src/utility/lsp-host/lsp-manager";

// ---------------------------------------------------------------------------
// Fake StdioLspAdapter — injected through LspManagerOpts.adapterFactory
// ---------------------------------------------------------------------------

type ServerNotificationHandler = (params: unknown) => void | Promise<void>;
type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;
type DeferredRequest = {
  method: string;
  signal?: AbortSignal;
  reject: (err: Error) => void;
  resolve: (value: unknown) => void;
};

interface FakeLspServerSpec {
  languageId: string;
}

const adapterInstances: FakeStdioLspAdapter[] = [];

function extractTextDocument(params: unknown): { uri: string; languageId: string } {
  const textDocument = (params as { textDocument?: { uri?: unknown; languageId?: unknown } })
    .textDocument;
  return {
    uri: typeof textDocument?.uri === "string" ? textDocument.uri : "",
    languageId: typeof textDocument?.languageId === "string" ? textDocument.languageId : "",
  };
}

function extractTextDocumentUri(params: unknown): string {
  return extractTextDocument(params).uri;
}

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
  readonly savedUris: string[] = [];
  readonly didChangeParams: unknown[] = [];
  readonly didSaveParams: unknown[] = [];
  readonly hoverUris: string[] = [];
  readonly definitionUris: string[] = [];
  readonly completionUris: string[] = [];
  readonly requestMethods: string[] = [];
  readonly notificationMethods: string[] = [];
  readonly notificationParams: unknown[] = [];
  readonly capabilities = new Set(["hoverProvider", "definitionProvider", "completionProvider"]);
  syncKind = 2;
  saveSupported = false;
  saveIncludeText = false;
  readonly notificationHandlers = new Map<string, ServerNotificationHandler>();
  readonly requestHandlers = new Map<string, ServerRequestHandler>();
  readonly deferredMethods = new Set<string>();
  readonly deferredRequests: DeferredRequest[] = [];

  constructor(spec: FakeLspServerSpec, workspaceId: string, workspaceRootUri: string | null) {
    this.languageId = spec.languageId;
    this.workspaceId = workspaceId;
    this.workspaceRootUri = workspaceRootUri;
    adapterInstances.push(this);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async request<TIn = unknown, TOut = unknown>(
    method: string,
    params: TIn,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TOut> {
    this.requestMethods.push(method);
    const uri = extractTextDocumentUri(params);
    if (this.deferredMethods.has(method)) {
      return new Promise<TOut>((resolve, reject) => {
        const abort = () => reject(new Error("Request cancelled"));
        opts.signal?.addEventListener("abort", abort, { once: true });
        this.deferredRequests.push({
          method,
          signal: opts.signal,
          reject,
          resolve: (value) => resolve(value as TOut),
        });
      });
    }
    if (method === "textDocument/hover") {
      this.hoverUris.push(uri);
      return { contents: `fake hover ${this.workspaceId}` } as TOut;
    }
    if (method === "textDocument/definition") {
      this.definitionUris.push(uri);
      return [
        {
          targetUri: uri,
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
          targetSelectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
        },
      ] as TOut;
    }
    if (method === "textDocument/completion") {
      this.completionUris.push(uri);
      return {
        items: [{ label: `fakeCompletion ${this.workspaceId}` }, { sortText: "invalid" }],
      } as TOut;
    }
    return null as TOut;
  }

  notify(method: string, params: unknown): void {
    this.notificationMethods.push(method);
    this.notificationParams.push(params);
    if (method === "textDocument/didOpen") {
      const textDocument = extractTextDocument(params);
      this.openedUris.push(textDocument.uri);
      this.openedLanguageIds.push(textDocument.languageId);
    }
    if (method === "textDocument/didChange") {
      this.changedUris.push(extractTextDocumentUri(params));
      this.didChangeParams.push(params);
    }
    if (method === "textDocument/didClose") {
      this.closedUris.push(extractTextDocumentUri(params));
    }
    if (method === "textDocument/didSave") {
      this.savedUris.push(extractTextDocumentUri(params));
      this.didSaveParams.push(params);
    }
  }

  notifyTextDocumentDidOpen(params: Parameters<LspAdapter["notifyTextDocumentDidOpen"]>[0]): void {
    if (this.syncKind === 0) return;
    this.notify("textDocument/didOpen", params);
  }

  notifyTextDocumentDidChange(
    params: Parameters<LspAdapter["notifyTextDocumentDidChange"]>[0],
  ): void {
    if (this.syncKind === 0) return;
    this.notify("textDocument/didChange", params);
  }

  notifyTextDocumentDidClose(
    params: Parameters<LspAdapter["notifyTextDocumentDidClose"]>[0],
  ): void {
    if (this.syncKind === 0) return;
    this.notify("textDocument/didClose", params);
  }

  notifyTextDocumentDidSave(params: Parameters<LspAdapter["notifyTextDocumentDidSave"]>[0]): void {
    if (!this.saveSupported) return;
    this.notify("textDocument/didSave", {
      textDocument: params.textDocument,
      ...(this.saveIncludeText && params.text !== undefined ? { text: params.text } : {}),
    });
  }

  onServerNotification(method: string, handler: ServerNotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  hasCapability(key: string, sub?: string): boolean {
    void sub;
    return this.capabilities.has(key);
  }

  dispose(): void {
    this.disposed = true;
  }
}

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

function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 3000) {
        reject(new Error(`waitUntil timed out: ${label}`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

function makeManager(opts: LspManagerOpts = {}): LspManager {
  return new LspManager({
    ...opts,
    adapterFactory:
      opts.adapterFactory ??
      ((spec, workspaceId, workspaceRootUri) =>
        new FakeStdioLspAdapter(spec, workspaceId, workspaceRootUri)),
  });
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

function serverRequestHandler(
  adapter: FakeStdioLspAdapter,
  method: string,
): ServerRequestHandler {
  const handler = adapter.requestHandlers.get(method);
  if (!handler) {
    throw new Error(`server request handler not found for ${method}`);
  }
  return handler;
}

function serverNotificationHandler(
  adapter: FakeStdioLspAdapter,
  method: string,
): ServerNotificationHandler {
  const handler = adapter.notificationHandlers.get(method);
  if (!handler) {
    throw new Error(`server notification handler not found for ${method}`);
  }
  return handler;
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
    const manager = makeManager();
    const port = new FakePort();
    manager.attachPort(port);

    expect(adapterInstances.length).toBe(0);
    manager.disposeAll();
  });

  test("first didOpen spawns one adapter, started and tagged with workspace data", async () => {
    const manager = makeManager();
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
    const manager = makeManager();
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-1", "file:///a.ts", 1);
    await openFile(port, "ws-1", "file:///b.ts", 2);

    expect(adapterInstances.length).toBe(1);
    manager.disposeAll();
  });

  test("javascript didOpen uses the TypeScript preset adapter without spawning a duplicate", async () => {
    const manager = makeManager();
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
    const manager = makeManager();
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
    const manager = makeManager();
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
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-idle", "file:///i.ts");
    expect(adapterInstances[0].disposed).toBe(false);

    await delay(IDLE_WAIT_MS);

    expect(adapterInstances[0].disposed).toBe(true);
  });

  test("activity within the window resets the timer (server stays alive)", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
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
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-dispose", "file:///d.ts");
    expect(adapterInstances[0].disposed).toBe(false);

    manager.disposeAll();
    expect(adapterInstances[0].disposed).toBe(true);
  });
});

describe("LspManager — workspace integration server requests", () => {
  let manager: InstanceType<typeof LspManager>;

  beforeEach(() => {
    adapterInstances.length = 0;
  });

  afterEach(() => {
    manager?.disposeAll();
  });

  test("workspace/configuration returns flattened initializationOptions by section", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-config", "file:///workspace/main.py", 1, {
      languageId: "python",
    });

    const result = await serverRequestHandler(
      adapterFor("ws-config"),
      "workspace/configuration",
    )({
      items: [
        { section: "python.analysis" },
        { section: "python.analysis.typeCheckingMode" },
        { section: "python.missing" },
      ],
    });

    expect(result).toEqual([
      {
        typeCheckingMode: "standard",
        diagnosticMode: "openFilesOnly",
        autoImportCompletions: true,
        useLibraryCodeForTypes: true,
      },
      "standard",
      null,
    ]);
  });

  test("client/registerCapability stores watchedFiles and fs changes forward to the adapter", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-watch", "file:///workspace/main.py", 1, {
      languageId: "python",
    });
    const adapter = adapterFor("ws-watch");

    const registerResult = await serverRequestHandler(adapter, "client/registerCapability")({
      registrations: [
        {
          id: "watch-1",
          method: "workspace/didChangeWatchedFiles",
          registerOptions: { watchers: [{ globPattern: "**" }] },
        },
      ],
    });
    expect(registerResult).toBeNull();

    port.deliver({
      type: "notify",
      method: "fsChanged",
      args: {
        workspaceId: "ws-watch",
        changes: [
          { relPath: "src/new.py", kind: "added" },
          { relPath: "src/existing.py", kind: "modified" },
          { relPath: "src/old.py", kind: "deleted" },
        ],
      },
    });

    const notifyIndex = adapter.notificationMethods.indexOf("workspace/didChangeWatchedFiles");
    expect(notifyIndex).toBeGreaterThan(-1);
    expect(adapter.notificationParams[notifyIndex]).toEqual({
      changes: [
        { uri: "file:///workspace/src/new.py", type: 1 },
        { uri: "file:///workspace/src/existing.py", type: 2 },
        { uri: "file:///workspace/src/old.py", type: 3 },
      ],
    });
  });

  test("client/registerCapability silently ignores non-whitelisted registrations", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-ignore", "file:///workspace/main.py", 1, {
      languageId: "python",
    });
    const adapter = adapterFor("ws-ignore");

    const registerResult = await serverRequestHandler(adapter, "client/registerCapability")({
      registrations: [
        {
          id: "show-message",
          method: "window/showMessage",
          registerOptions: {},
        },
      ],
    });
    expect(registerResult).toBeNull();

    port.deliver({
      type: "notify",
      method: "fsChanged",
      args: {
        workspaceId: "ws-ignore",
        changes: [{ relPath: "src/ignored.py", kind: "modified" }],
      },
    });

    expect(adapter.notificationMethods).not.toContain("workspace/didChangeWatchedFiles");
  });

  test("server notifications are routed to main as serverEvent payloads", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-ux", "file:///workspace/main.ts", 1);
    const params = { type: 3, message: "language server ready" };

    await serverNotificationHandler(adapterFor("ws-ux"), "window/logMessage")(params);

    expect(port.sent.at(-1)).toEqual({
      type: "serverEvent",
      workspaceId: "ws-ux",
      languageId: "typescript",
      method: "window/logMessage",
      params,
    });
  });

  test("window/showMessageRequest forwards an event and auto-returns first action or null", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-message", "file:///workspace/main.ts", 1);
    const handler = serverRequestHandler(adapterFor("ws-message"), "window/showMessageRequest");

    const firstAction = await handler({
      type: 2,
      message: "Choose a path",
      actions: [{ title: "Use default" }, { title: "Cancel" }],
    });
    const noAction = await handler({ type: 3, message: "No action supplied" });

    expect(firstAction).toEqual({ title: "Use default" });
    expect(noAction).toBeNull();
    expect(port.sent.at(-2)).toMatchObject({
      type: "serverEvent",
      workspaceId: "ws-message",
      languageId: "typescript",
      method: "window/showMessageRequest",
    });
    expect(port.sent.at(-1)).toMatchObject({
      type: "serverEvent",
      workspaceId: "ws-message",
      languageId: "typescript",
      method: "window/showMessageRequest",
    });
  });

  test("window/workDoneProgress/create forwards token event and returns null immediately", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-progress", "file:///workspace/main.ts", 1);
    const params = { token: "build-1" };
    const result = await serverRequestHandler(
      adapterFor("ws-progress"),
      "window/workDoneProgress/create",
    )(params);

    expect(result).toBeNull();
    expect(port.sent.at(-1)).toEqual({
      type: "serverEvent",
      workspaceId: "ws-progress",
      languageId: "typescript",
      method: "window/workDoneProgress/create",
      params,
    });
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
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-close", "file:///c.ts", 1);

    port.deliver(makeCallMsg("didClose", { uri: "file:///c.ts" }, 2));
    await port.waitForMessages(2);

    expect(adapterInstances[0].closedUris).toEqual(["file:///c.ts"]);
  });

  test("didClose resets the idle timer (server stays alive past original deadline)", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
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
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
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
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
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
    manager = makeManager({ idleTimeoutMs: 200 });
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
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-a", "file:///a.ts", 1);
    await openFile(port, "ws-b", "file:///b.ts", 2);

    port.deliver(
      makeCallMsg(
        "didChange",
        {
          uri: "file:///b.ts",
          version: 2,
          contentChanges: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              rangeLength: 0,
              text: "b",
            },
          ],
        },
        3,
      ),
    );
    await port.waitForMessages(3);

    expect(adapterFor("ws-a").changedUris).toEqual([]);
    expect(adapterFor("ws-b").changedUris).toEqual(["file:///b.ts"]);
    expect(adapterFor("ws-b").didChangeParams).toEqual([
      {
        textDocument: { uri: "file:///b.ts", version: 2 },
        contentChanges: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            rangeLength: 0,
            text: "b",
          },
        ],
      },
    ]);
  });

  test("didSave dispatches to the adapter indexed for the uri", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-a", "file:///a.ts", 1);
    await openFile(port, "ws-b", "file:///b.ts", 2);
    adapterFor("ws-b").saveSupported = true;
    adapterFor("ws-b").saveIncludeText = true;

    port.deliver(makeCallMsg("didSave", { uri: "file:///b.ts", text: "saved" }, 3));
    await port.waitForMessages(3);

    expect(adapterFor("ws-a").savedUris).toEqual([]);
    expect(adapterFor("ws-b").savedUris).toEqual(["file:///b.ts"]);
    expect(adapterFor("ws-b").didSaveParams).toEqual([
      {
        textDocument: { uri: "file:///b.ts" },
        text: "saved",
      },
    ]);
  });

  test("didClose dispatches to the indexed adapter and removes only that uri", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
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
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
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
    expect(port.sent[3]).toMatchObject({
      type: "response",
      id: 4,
      result: [
        {
          uri: "file:///b.ts",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
        },
      ],
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
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-index", "file:///indexed.ts", 1);

    expect(getUriIndex(manager).get("file:///indexed.ts")).toEqual({
      workspaceId: "ws-index",
      presetLanguageId: "typescript",
    });
  });

  test("didClose removes the uri from the index", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-index-close", "file:///closed.ts", 1);
    expect(getUriIndex(manager).has("file:///closed.ts")).toBe(true);

    port.deliver(makeCallMsg("didClose", { uri: "file:///closed.ts" }, 2));
    await port.waitForMessages(2);

    expect(getUriIndex(manager).has("file:///closed.ts")).toBe(false);
  });

  test("server shutdown removes index entries for that workspace", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-index-idle", "file:///idle.ts", 1);
    expect(getUriIndex(manager).has("file:///idle.ts")).toBe(true);

    await delay(IDLE_WAIT_MS);

    expect(adapterInstances[0].disposed).toBe(true);
    expect(getUriIndex(manager).has("file:///idle.ts")).toBe(false);
  });

  test("disposeAll removes all indexed uris", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-index-a", "file:///a.ts", 1);
    await openFile(port, "ws-index-b", "file:///b.ts", 2);
    expect(getUriIndex(manager).size).toBe(2);

    manager.disposeAll();

    expect(getUriIndex(manager).size).toBe(0);
  });
});

describe("LspManager — server capability gating", () => {
  let manager: InstanceType<typeof LspManager>;

  beforeEach(() => {
    adapterInstances.length = 0;
  });

  afterEach(() => {
    manager?.disposeAll();
  });

  test("unsupported hover, definition, and completion return empty responses without LSP requests", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-caps", "file:///caps.ts", 1);
    const adapter = adapterFor("ws-caps");
    adapter.capabilities.delete("hoverProvider");
    adapter.capabilities.delete("definitionProvider");
    adapter.capabilities.delete("completionProvider");

    port.deliver(makeCallMsg("hover", { uri: "file:///caps.ts", line: 0, character: 0 }, 2));
    await port.waitForMessages(2);
    port.deliver(makeCallMsg("definition", { uri: "file:///caps.ts", line: 0, character: 0 }, 3));
    await port.waitForMessages(3);
    port.deliver(makeCallMsg("completion", { uri: "file:///caps.ts", line: 0, character: 0 }, 4));
    await port.waitForMessages(4);

    expect(adapter.requestMethods).toEqual([]);
    expect(port.sent[1]).toMatchObject({ type: "response", id: 2, result: null });
    expect(port.sent[2]).toMatchObject({ type: "response", id: 3, result: [] });
    expect(port.sent[3]).toMatchObject({ type: "response", id: 4, result: [] });
  });
});

describe("LspManager — cancellation forwarding", () => {
  let manager: InstanceType<typeof LspManager>;

  beforeEach(() => {
    adapterInstances.length = 0;
  });

  afterEach(() => {
    manager?.disposeAll();
  });

  test("cancel message aborts the signal passed to the in-flight adapter request", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-cancel", "file:///cancel.ts", 1);
    const adapter = adapterFor("ws-cancel");
    adapter.deferredMethods.add("textDocument/hover");

    port.deliver(makeCallMsg("hover", { uri: "file:///cancel.ts", line: 0, character: 0 }, 2));
    await waitUntil(() => adapter.deferredRequests.length === 1, "deferred hover request");

    expect(adapter.deferredRequests[0].signal?.aborted).toBe(false);

    port.deliver({ type: "cancel", id: 2 });
    await port.waitForMessages(2);

    expect(adapter.deferredRequests[0].signal?.aborted).toBe(true);
    expect(port.sent[1]).toMatchObject({
      type: "response",
      id: 2,
      error: "Request cancelled",
    });
  });
});
