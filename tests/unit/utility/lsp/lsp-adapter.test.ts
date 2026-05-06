import { describe, expect, test } from "bun:test";
import {
  applyTextDocumentContentChanges,
  StdioLspAdapter,
} from "../../../../src/utility/lsp-host/servers/stdio-lsp-adapter";

class FakeStdin {
  readonly writes: Buffer[] = [];

  write(chunk: Buffer): boolean {
    this.writes.push(chunk);
    return true;
  }
}

interface AdapterInternals {
  proc: { stdin: FakeStdin };
  pending: Map<number, unknown>;
  serverCapabilities: Record<string, unknown>;
  textDocumentCache: Map<string, string>;
  sendInitialize(): Promise<void>;
  handleMessage(msg: Record<string, unknown>): void;
}

function makeAdapter(): {
  adapter: StdioLspAdapter;
  stdin: FakeStdin;
  internals: AdapterInternals;
} {
  const adapter = new StdioLspAdapter(
    { languageId: "typescript", binary: "typescript-language-server", args: ["--stdio"] },
    "ws-test",
    "file:///workspace",
  );
  const stdin = new FakeStdin();
  const internals = adapter as unknown as AdapterInternals;
  internals.proc = { stdin };
  return { adapter, stdin, internals };
}

function decodeMessage(buffer: Buffer): Record<string, unknown> {
  const separator = buffer.indexOf("\r\n\r\n");
  expect(separator).toBeGreaterThan(-1);
  return JSON.parse(buffer.slice(separator + 4).toString("utf8")) as Record<string, unknown>;
}

function didOpenParams(
  uri = "file:///workspace/main.ts",
  text = "hello",
): Parameters<StdioLspAdapter["notifyTextDocumentDidOpen"]>[0] {
  return {
    textDocument: {
      uri,
      languageId: "typescript",
      version: 1,
      text,
    },
  };
}

function didChangeParams(
  uri = "file:///workspace/main.ts",
  version = 2,
  text = "!",
): Parameters<StdioLspAdapter["notifyTextDocumentDidChange"]>[0] {
  return {
    textDocument: { uri, version },
    contentChanges: [
      {
        range: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 5 },
        },
        rangeLength: 0,
        text,
      },
    ],
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function pendingSize(adapter: StdioLspAdapter): number {
  return (adapter as unknown as AdapterInternals).pending.size;
}

function textDocumentCache(adapter: StdioLspAdapter): Map<string, string> {
  return (adapter as unknown as AdapterInternals).textDocumentCache;
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`Expected Error rejection, got ${String(err)}`);
  }
  throw new Error("Expected promise to reject");
}

describe("StdioLspAdapter — server-initiated messages", () => {
  test("initialize advertises the dynamicRegistration whitelist and stores server capabilities", async () => {
    const { adapter, stdin, internals } = makeAdapter();

    const initialize = internals.sendInitialize();
    expect(stdin.writes).toHaveLength(1);

    const initializeRequest = decodeMessage(stdin.writes[0]);
    expect(initializeRequest).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(initializeRequest.params).toMatchObject({
      capabilities: {
        window: {
          workDoneProgress: true,
          showMessage: {
            messageActionItem: {
              additionalPropertiesSupport: true,
            },
          },
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: true,
          },
          hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
          definition: { dynamicRegistration: false },
          completion: {
            dynamicRegistration: false,
            completionItem: { snippetSupport: false },
          },
          publishDiagnostics: {
            tagSupport: { valueSet: [1, 2] },
          },
        },
        workspace: {
          didChangeWatchedFiles: { dynamicRegistration: true },
        },
      },
    });

    internals.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        capabilities: {
          hoverProvider: true,
          completionProvider: { triggerCharacters: ["."] },
          definitionProvider: false,
          experimentalProvider: { mode: "passthrough" },
        },
      },
    });
    await initialize;

    expect(adapter.hasCapability("hoverProvider")).toBe(true);
    expect(adapter.hasCapability("completionProvider")).toBe(true);
    expect(adapter.hasCapability("completionProvider", "triggerCharacters")).toBe(true);
    expect(adapter.hasCapability("definitionProvider")).toBe(false);
    expect(adapter.hasCapability("experimentalProvider")).toBe(true);
    expect(adapter.hasCapability("missingProvider")).toBe(false);

    expect(stdin.writes).toHaveLength(2);
    expect(decodeMessage(stdin.writes[1])).toMatchObject({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
  });

  test("unknown server-initiated request auto-responds with -32601", async () => {
    const { stdin, internals } = makeAdapter();

    internals.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "workspace/configuration",
      params: { items: [] },
    });
    await nextTick();

    expect(stdin.writes).toHaveLength(1);
    expect(decodeMessage(stdin.writes[0])).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
  });

  test("registered onServerRequest handler is called and result is sent", async () => {
    const { adapter, stdin, internals } = makeAdapter();
    let seenParams: unknown = null;

    adapter.onServerRequest("workspace/configuration", async (params) => {
      seenParams = params;
      return [{ python: { analysis: { typeCheckingMode: "standard" } } }];
    });

    internals.handleMessage({
      jsonrpc: "2.0",
      id: "cfg-1",
      method: "workspace/configuration",
      params: { items: [{ section: "python" }] },
    });
    await nextTick();

    expect(seenParams).toEqual({ items: [{ section: "python" }] });
    expect(stdin.writes).toHaveLength(1);
    expect(decodeMessage(stdin.writes[0])).toMatchObject({
      jsonrpc: "2.0",
      id: "cfg-1",
      result: [{ python: { analysis: { typeCheckingMode: "standard" } } }],
    });
  });

  test("registered onServerNotification handler is called without sending a response", async () => {
    const { adapter, stdin, internals } = makeAdapter();
    let seenParams: unknown = null;

    adapter.onServerNotification("window/logMessage", (params) => {
      seenParams = params;
    });

    internals.handleMessage({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: { type: 3, message: "indexed" },
    });
    await nextTick();

    expect(seenParams).toEqual({ type: 3, message: "indexed" });
    expect(stdin.writes).toHaveLength(0);
  });
});

describe("StdioLspAdapter — text document synchronization negotiation", () => {
  test("incremental sync passes contentChanges through and updates the cache", () => {
    const { adapter, stdin, internals } = makeAdapter();
    internals.serverCapabilities = { textDocumentSync: 2 };

    adapter.notifyTextDocumentDidOpen(didOpenParams("file:///workspace/main.ts", "hello"));
    adapter.notifyTextDocumentDidChange(didChangeParams("file:///workspace/main.ts", 2, "!"));

    expect(stdin.writes).toHaveLength(2);
    expect(decodeMessage(stdin.writes[1])).toMatchObject({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: "file:///workspace/main.ts", version: 2 },
        contentChanges: [
          {
            range: {
              start: { line: 0, character: 5 },
              end: { line: 0, character: 5 },
            },
            rangeLength: 0,
            text: "!",
          },
        ],
      },
    });
    expect(textDocumentCache(adapter).get("file:///workspace/main.ts")).toBe("hello!");
  });

  test("full sync reconstructs cache and sends a full replacement change", () => {
    const { adapter, stdin, internals } = makeAdapter();
    internals.serverCapabilities = { textDocumentSync: 1 };

    adapter.notifyTextDocumentDidOpen(didOpenParams("file:///workspace/main.ts", "hello\nworld"));
    adapter.notifyTextDocumentDidChange({
      textDocument: { uri: "file:///workspace/main.ts", version: 2 },
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 5 },
            end: { line: 0, character: 5 },
          },
          rangeLength: 0,
          text: "!",
        },
      ],
    });

    expect(stdin.writes).toHaveLength(2);
    expect(decodeMessage(stdin.writes[1])).toMatchObject({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri: "file:///workspace/main.ts", version: 2 },
        contentChanges: [{ text: "hello!\nworld" }],
      },
    });
    expect(textDocumentCache(adapter).get("file:///workspace/main.ts")).toBe("hello!\nworld");
  });

  test("none sync seeds and clears cache but skips sync notifications", () => {
    const { adapter, stdin, internals } = makeAdapter();
    internals.serverCapabilities = { textDocumentSync: 0 };

    adapter.notifyTextDocumentDidOpen(didOpenParams("file:///workspace/main.ts", "hello"));
    expect(textDocumentCache(adapter).get("file:///workspace/main.ts")).toBe("hello");

    adapter.notifyTextDocumentDidChange(didChangeParams("file:///workspace/main.ts", 2, "!"));
    adapter.notifyTextDocumentDidClose({ textDocument: { uri: "file:///workspace/main.ts" } });

    expect(stdin.writes).toHaveLength(0);
    expect(textDocumentCache(adapter).has("file:///workspace/main.ts")).toBe(false);
  });

  test("didSave includes text only when save.includeText is true", () => {
    const { adapter, stdin, internals } = makeAdapter();
    internals.serverCapabilities = {
      textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
    };

    adapter.notifyTextDocumentDidSave({
      textDocument: { uri: "file:///workspace/main.ts" },
      text: "saved text",
    });

    expect(stdin.writes).toHaveLength(1);
    expect(decodeMessage(stdin.writes[0])).toMatchObject({
      jsonrpc: "2.0",
      method: "textDocument/didSave",
      params: {
        textDocument: { uri: "file:///workspace/main.ts" },
        text: "saved text",
      },
    });
  });

  test("didSave is skipped when save support is undefined", () => {
    const { adapter, stdin, internals } = makeAdapter();
    internals.serverCapabilities = {
      textDocumentSync: { openClose: true, change: 2 },
    };

    adapter.notifyTextDocumentDidSave({
      textDocument: { uri: "file:///workspace/main.ts" },
      text: "saved text",
    });

    expect(stdin.writes).toHaveLength(0);
  });

  test("content change reconstruction applies range replacements in order", () => {
    expect(
      applyTextDocumentContentChanges("alpha\nbeta", [
        {
          range: {
            start: { line: 0, character: 5 },
            end: { line: 0, character: 5 },
          },
          rangeLength: 0,
          text: "!",
        },
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 4 },
          },
          rangeLength: 4,
          text: "BETA",
        },
      ]),
    ).toBe("alpha!\nBETA");
  });
});

describe("StdioLspAdapter — request cancellation", () => {
  test("abort sends $/cancelRequest, rejects, and removes the pending request", async () => {
    const { adapter, stdin } = makeAdapter();
    const controller = new AbortController();

    const request = adapter.request("textDocument/hover", {}, { signal: controller.signal });
    const rejected = rejectionOf(request);

    expect(stdin.writes).toHaveLength(1);
    expect(pendingSize(adapter)).toBe(1);

    controller.abort();
    const err = await rejected;

    expect(err.message).toBe("Request cancelled");
    expect(pendingSize(adapter)).toBe(0);
    expect(stdin.writes).toHaveLength(2);
    expect(decodeMessage(stdin.writes[1])).toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 1 },
    });
  });

  test("aborting 100 pending requests leaves no pending leak", async () => {
    const { adapter, stdin } = makeAdapter();
    const controllers = Array.from({ length: 100 }, () => new AbortController());
    const requests = controllers.map((controller) =>
      adapter.request("textDocument/hover", {}, { signal: controller.signal }).catch((err) => err),
    );

    expect(pendingSize(adapter)).toBe(100);
    expect(stdin.writes).toHaveLength(100);

    for (const controller of controllers) {
      controller.abort();
    }
    const errors = await Promise.all(requests);

    expect(errors.every((err) => err instanceof Error && err.name === "AbortError")).toBe(true);
    expect(pendingSize(adapter)).toBe(0);
    expect(stdin.writes).toHaveLength(200);
    expect(decodeMessage(stdin.writes[199])).toEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 100 },
    });
  });

  test("response before abort resolves and does not send cancel later", async () => {
    const { adapter, stdin, internals } = makeAdapter();
    const controller = new AbortController();

    const request = adapter.request("textDocument/hover", {}, { signal: controller.signal });
    internals.handleMessage({ jsonrpc: "2.0", id: 1, result: { contents: "ok" } });

    await expect(request).resolves.toEqual({ contents: "ok" });
    expect(pendingSize(adapter)).toBe(0);

    controller.abort();

    expect(stdin.writes).toHaveLength(1);
  });

  test("response after abort is silently dropped without throwing", async () => {
    const { adapter, stdin, internals } = makeAdapter();
    const controller = new AbortController();

    const request = adapter.request("textDocument/hover", {}, { signal: controller.signal });
    const rejected = rejectionOf(request);
    controller.abort();
    const err = await rejected;
    expect(err.message).toBe("Request cancelled");

    expect(() => {
      internals.handleMessage({ jsonrpc: "2.0", id: 1, result: { contents: "late" } });
    }).not.toThrow();

    expect(pendingSize(adapter)).toBe(0);
    expect(stdin.writes).toHaveLength(2);
  });
});
