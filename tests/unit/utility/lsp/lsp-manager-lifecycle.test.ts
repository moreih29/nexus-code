// Unit tests for LspManager lifecycle — lazy spawn, idle shutdown,
// didClose lifecycle, server request handlers (configuration / capability
// registration / apply-edit / message dialogs / progress).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LspManager } from "../../../../src/utility/lsp-host/lsp-manager";
import {
  adapterFor,
  adapterInstances,
  delay,
  FAST_IDLE_MS,
  FakePort,
  IDLE_WAIT_MS,
  makeCallMsg,
  makeManager,
  openFile,
  serverNotificationHandler,
  serverRequestHandler,
} from "./lsp-manager-test-helpers";

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
    const uriIndex = (manager as unknown as { uriIndex: Map<string, unknown> }).uriIndex;
    expect(uriIndex.get("file:///b.js")).toEqual({
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
    const uriIndex = (manager as unknown as { uriIndex: Map<string, unknown> }).uriIndex;
    expect(uriIndex.has("file:///unsupported.rs")).toBe(false);
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

    const registerResult = await serverRequestHandler(
      adapter,
      "client/registerCapability",
    )({
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

    const registerResult = await serverRequestHandler(
      adapter,
      "client/registerCapability",
    )({
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
