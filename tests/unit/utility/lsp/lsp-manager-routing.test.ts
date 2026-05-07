// Unit tests for LspManager — URI routing, workspace-symbol fan-out,
// capability gating, URI index maintenance, and cancellation forwarding.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LspManager } from "../../../../src/utility/lsp-host/lsp-manager";
import {
  adapterFor,
  adapterForLanguage,
  adapterInstances,
  delay,
  FAST_IDLE_MS,
  FakePort,
  getUriIndex,
  IDLE_WAIT_MS,
  lspRange,
  makeCallMsg,
  makeManager,
  openFile,
  waitUntil,
} from "./lsp-manager-test-helpers";

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

  test("references, documentHighlight, and documentSymbol dispatch to the adapter indexed for the uri", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-a", "file:///a.ts", 1);
    await openFile(port, "ws-b", "file:///b.ts", 2);

    port.deliver(
      makeCallMsg(
        "references",
        {
          uri: "file:///b.ts",
          line: 1,
          character: 2,
          includeDeclaration: false,
        },
        3,
      ),
    );
    await port.waitForMessages(3);
    port.deliver(
      makeCallMsg("documentHighlight", { uri: "file:///b.ts", line: 1, character: 2 }, 4),
    );
    await port.waitForMessages(4);
    port.deliver(makeCallMsg("documentSymbol", { uri: "file:///b.ts" }, 5));
    await port.waitForMessages(5);

    expect(adapterFor("ws-a").referencesUris).toEqual([]);
    expect(adapterFor("ws-a").documentHighlightUris).toEqual([]);
    expect(adapterFor("ws-a").documentSymbolUris).toEqual([]);
    expect(adapterFor("ws-b").referencesUris).toEqual(["file:///b.ts"]);
    expect(adapterFor("ws-b").documentHighlightUris).toEqual(["file:///b.ts"]);
    expect(adapterFor("ws-b").documentSymbolUris).toEqual(["file:///b.ts"]);
    expect(port.sent[2]).toMatchObject({
      type: "response",
      id: 3,
      result: [{ uri: "file:///b.ts", range: lspRange }],
    });
    expect(port.sent[3]).toMatchObject({
      type: "response",
      id: 4,
      result: [{ range: lspRange, kind: 3 }],
    });
    expect(port.sent[4]).toMatchObject({
      type: "response",
      id: 5,
      result: [
        {
          name: "FakeClass",
          kind: 5,
          range: lspRange,
          selectionRange: lspRange,
          children: [{ name: "method", kind: 6, range: lspRange, selectionRange: lspRange }],
        },
      ],
    });
  });

  test("documentSymbol returns [] and warns when a server returns flat symbols", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      await openFile(port, "ws-flat-symbols", "file:///flat.ts", 1);
      adapterFor("ws-flat-symbols").documentSymbolResult = [
        {
          name: "flat",
          kind: 12,
          location: { uri: "file:///flat.ts", range: lspRange },
        },
      ];

      port.deliver(makeCallMsg("documentSymbol", { uri: "file:///flat.ts" }, 2));
      await port.waitForMessages(2);

      expect(port.sent[1]).toMatchObject({ type: "response", id: 2, result: [] });
      expect(warnings[0]?.[0]).toBe(
        "[lsp-manager] textDocument/documentSymbol returned non-hierarchical symbols",
      );
    } finally {
      console.warn = originalWarn;
    }
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

describe("LspManager — workspace/symbol fan-out", () => {
  let manager: InstanceType<typeof LspManager>;

  beforeEach(() => {
    adapterInstances.length = 0;
  });

  afterEach(() => {
    manager?.disposeAll();
  });

  test("workspaceSymbol fans out to all adapters in the workspace and concatenates fulfilled results", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-symbol", "file:///workspace/main.ts", 1);
    await openFile(port, "ws-symbol", "file:///workspace/main.py", 2, { languageId: "python" });
    const ts = adapterForLanguage("ws-symbol", "typescript");
    const py = adapterForLanguage("ws-symbol", "python");
    ts.workspaceSymbolResult = [
      {
        name: "TsSymbol",
        kind: 12,
        location: { uri: "file:///workspace/main.ts", range: lspRange },
      },
    ];
    py.workspaceSymbolResult = [
      { name: "invalid" },
      {
        name: "PySymbol",
        kind: 12,
        location: { uri: "file:///workspace/main.py", range: lspRange },
      },
    ];

    port.deliver(makeCallMsg("workspaceSymbol", { workspaceId: "ws-symbol", query: "Symbol" }, 3));
    await port.waitForMessages(3);

    expect(ts.workspaceSymbolQueries).toEqual(["Symbol"]);
    expect(py.workspaceSymbolQueries).toEqual(["Symbol"]);
    expect(port.sent[2]).toMatchObject({
      type: "response",
      id: 3,
      result: [
        {
          name: "TsSymbol",
          kind: 12,
          location: { uri: "file:///workspace/main.ts", range: lspRange },
        },
        {
          name: "PySymbol",
          kind: 12,
          location: { uri: "file:///workspace/main.py", range: lspRange },
        },
      ],
    });
  });

  test("workspaceSymbol returns fulfilled results and warns when one adapter rejects", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      await openFile(port, "ws-one-fails", "file:///workspace/main.ts", 1);
      await openFile(port, "ws-one-fails", "file:///workspace/main.py", 2, {
        languageId: "python",
      });
      const ts = adapterForLanguage("ws-one-fails", "typescript");
      const py = adapterForLanguage("ws-one-fails", "python");
      py.failingMethods.add("workspace/symbol");
      ts.workspaceSymbolResult = [
        {
          name: "OnlySuccess",
          kind: 12,
          location: { uri: "file:///workspace/main.ts", range: lspRange },
        },
      ];

      port.deliver(
        makeCallMsg("workspaceSymbol", { workspaceId: "ws-one-fails", query: "Only" }, 3),
      );
      await port.waitForMessages(3);

      expect(ts.requestMethods).toContain("workspace/symbol");
      expect(py.requestMethods).toContain("workspace/symbol");
      expect(port.sent[2]).toMatchObject({
        type: "response",
        id: 3,
        result: [
          {
            name: "OnlySuccess",
            kind: 12,
            location: { uri: "file:///workspace/main.ts", range: lspRange },
          },
        ],
      });
      expect(warnings[0]?.[0]).toBe("[lsp-manager] workspace/symbol fan-out request failed");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("workspaceSymbol returns [] and warns when all adapters reject", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      await openFile(port, "ws-all-fail", "file:///workspace/main.ts", 1);
      await openFile(port, "ws-all-fail", "file:///workspace/main.py", 2, {
        languageId: "python",
      });
      adapterForLanguage("ws-all-fail", "typescript").failingMethods.add("workspace/symbol");
      adapterForLanguage("ws-all-fail", "python").failingMethods.add("workspace/symbol");

      port.deliver(
        makeCallMsg("workspaceSymbol", { workspaceId: "ws-all-fail", query: "Missing" }, 3),
      );
      await port.waitForMessages(3);

      expect(port.sent[2]).toMatchObject({ type: "response", id: 3, result: [] });
      expect(warnings).toHaveLength(2);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("workspaceSymbol returns [] when there are zero adapters for the workspace", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    port.deliver(makeCallMsg("workspaceSymbol", { workspaceId: "ws-empty", query: "Anything" }, 1));
    await port.waitForMessages(1);

    expect(adapterInstances).toHaveLength(0);
    expect(port.sent[0]).toMatchObject({ type: "response", id: 1, result: [] });
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

  test("unsupported request providers return empty responses without LSP requests", async () => {
    manager = makeManager({ idleTimeoutMs: FAST_IDLE_MS });
    const port = new FakePort();
    manager.attachPort(port);

    await openFile(port, "ws-caps", "file:///caps.ts", 1);
    const adapter = adapterFor("ws-caps");
    adapter.capabilities.delete("hoverProvider");
    adapter.capabilities.delete("definitionProvider");
    adapter.capabilities.delete("completionProvider");
    adapter.capabilities.delete("referencesProvider");
    adapter.capabilities.delete("documentHighlightProvider");
    adapter.capabilities.delete("documentSymbolProvider");
    adapter.capabilities.delete("workspaceSymbolProvider");

    port.deliver(makeCallMsg("hover", { uri: "file:///caps.ts", line: 0, character: 0 }, 2));
    await port.waitForMessages(2);
    port.deliver(makeCallMsg("definition", { uri: "file:///caps.ts", line: 0, character: 0 }, 3));
    await port.waitForMessages(3);
    port.deliver(makeCallMsg("completion", { uri: "file:///caps.ts", line: 0, character: 0 }, 4));
    await port.waitForMessages(4);
    port.deliver(
      makeCallMsg(
        "references",
        { uri: "file:///caps.ts", line: 0, character: 0, includeDeclaration: true },
        5,
      ),
    );
    await port.waitForMessages(5);
    port.deliver(
      makeCallMsg("documentHighlight", { uri: "file:///caps.ts", line: 0, character: 0 }, 6),
    );
    await port.waitForMessages(6);
    port.deliver(makeCallMsg("documentSymbol", { uri: "file:///caps.ts" }, 7));
    await port.waitForMessages(7);
    port.deliver(makeCallMsg("workspaceSymbol", { workspaceId: "ws-caps", query: "Caps" }, 8));
    await port.waitForMessages(8);

    expect(adapter.requestMethods).toEqual([]);
    expect(port.sent[1]).toMatchObject({ type: "response", id: 2, result: null });
    expect(port.sent[2]).toMatchObject({ type: "response", id: 3, result: [] });
    expect(port.sent[3]).toMatchObject({ type: "response", id: 4, result: [] });
    expect(port.sent[4]).toMatchObject({ type: "response", id: 5, result: [] });
    expect(port.sent[5]).toMatchObject({ type: "response", id: 6, result: [] });
    expect(port.sent[6]).toMatchObject({ type: "response", id: 7, result: [] });
    expect(port.sent[7]).toMatchObject({ type: "response", id: 8, result: [] });
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
