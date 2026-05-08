// Direct unit tests for lsp-handlers.ts:
//   - invokeLspHandler (request vs notify branching)
//   - parseHandlerOutput (schema validation pass / throw)
//   - fsChangeKindToLspType (all known kinds + fallback)
//   - handlerMetadata catalog (input/output schema samples for key handlers)

import { describe, expect, mock, test } from "bun:test";
import {
  FileChangeType,
  type FileEvent,
} from "../../../../src/shared/lsp";
import type { LspAdapter } from "../../../../src/utility/lsp-host/servers/stdio-lsp-adapter";
import {
  fsChangeKindToLspType,
  handlerMetadata,
  invokeLspHandler,
  parseHandlerOutput,
} from "../../../../src/utility/lsp-host/lsp-handlers";

// ---------------------------------------------------------------------------
// Minimal fake adapter — only the surfaces invokeLspHandler calls
// ---------------------------------------------------------------------------

function makeFakeAdapter(): LspAdapter & {
  requestCalls: { method: string; params: unknown; signal?: AbortSignal }[];
  notifyCalls: { method: string; params: unknown }[];
} {
  const requestCalls: { method: string; params: unknown; signal?: AbortSignal }[] = [];
  const notifyCalls: { method: string; params: unknown }[] = [];

  const adapter = {
    requestCalls,
    notifyCalls,
    async request<TOut = unknown>(
      method: string,
      params: unknown,
      opts: { signal?: AbortSignal } = {},
    ): Promise<TOut> {
      requestCalls.push({ method, params, signal: opts.signal });
      return null as TOut;
    },
    notify(method: string, params: unknown): void {
      notifyCalls.push({ method, params });
    },
    // Remaining LspAdapter members — unused by invokeLspHandler
    async start() {},
    notifyTextDocumentDidOpen: mock(() => {}),
    notifyTextDocumentDidChange: mock(() => {}),
    notifyTextDocumentDidClose: mock(() => {}),
    notifyTextDocumentDidSave: mock(() => {}),
    onServerNotification: mock(() => {}),
    onServerRequest: mock(() => {}),
    hasCapability: mock(() => false),
    dispose: mock(() => {}),
    languageId: "typescript",
    workspaceId: "ws-test",
    workspaceRootUri: null,
    syncKind: 2,
    saveSupported: false,
    saveIncludeText: false,
  } as unknown as LspAdapter & {
    requestCalls: typeof requestCalls;
    notifyCalls: typeof notifyCalls;
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// invokeLspHandler — request branch
// ---------------------------------------------------------------------------

describe("invokeLspHandler — request kind", () => {
  test("calls adapter.request with lspMethod and params, returns result", async () => {
    const adapter = makeFakeAdapter();
    const sentinelResult = { contents: "hover result" };
    adapter.request = async (_method, _params) => sentinelResult as unknown as never;

    const args = { uri: "file:///a.ts", line: 3, character: 7 };
    const result = await invokeLspHandler(handlerMetadata.hover, adapter, args);

    expect(result).toEqual(sentinelResult);
  });

  test("passes the lspMethod string to adapter.request", async () => {
    const adapter = makeFakeAdapter();
    const args = { uri: "file:///a.ts", line: 0, character: 0 };
    await invokeLspHandler(handlerMetadata.hover, adapter, args);

    expect(adapter.requestCalls).toHaveLength(1);
    expect(adapter.requestCalls[0].method).toBe("textDocument/hover");
  });

  test("passes AbortSignal to adapter.request when provided", async () => {
    const adapter = makeFakeAdapter();
    const controller = new AbortController();
    const args = { uri: "file:///a.ts", line: 0, character: 0 };
    await invokeLspHandler(handlerMetadata.definition, adapter, args, controller.signal);

    expect(adapter.requestCalls[0].signal).toBe(controller.signal);
  });

  test("does NOT call adapter.notify for request-kind handlers", async () => {
    const adapter = makeFakeAdapter();
    const args = { uri: "file:///a.ts", line: 0, character: 0 };
    await invokeLspHandler(handlerMetadata.completion, adapter, args);

    expect(adapter.notifyCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// invokeLspHandler — notify branch
// ---------------------------------------------------------------------------

describe("invokeLspHandler — notify kind", () => {
  // All four notify handlers (didOpen, didChange, didSave, didClose) use custom
  // `invoke` functions that call the typed notifyTextDocument* methods rather than
  // the generic adapter.notify. The generic notify path is only used when a notify
  // handler has no custom invoke.

  test("didChange invokes notifyTextDocumentDidChange (custom invoke path)", async () => {
    const adapter = makeFakeAdapter();
    const didChangeCalls: unknown[] = [];
    adapter.notifyTextDocumentDidChange = (params: unknown) => {
      didChangeCalls.push(params);
    };

    const args = {
      uri: "file:///b.ts",
      version: 2,
      contentChanges: [{ text: "new content" }],
    };
    const result = await invokeLspHandler(handlerMetadata.didChange, adapter, args);

    expect(didChangeCalls).toHaveLength(1);
    expect(result).toBeNull();
    // generic notify should NOT have been called
    expect(adapter.notifyCalls).toHaveLength(0);
    expect(adapter.requestCalls).toHaveLength(0);
  });

  test("didClose invokes notifyTextDocumentDidClose and returns null", async () => {
    const adapter = makeFakeAdapter();
    const didCloseCalls: unknown[] = [];
    adapter.notifyTextDocumentDidClose = (params: unknown) => {
      didCloseCalls.push(params);
    };

    const args = { uri: "file:///close-me.ts" };
    const result = await invokeLspHandler(handlerMetadata.didClose, adapter, args);

    expect(didCloseCalls).toHaveLength(1);
    expect(result).toBeNull();
    expect(adapter.requestCalls).toHaveLength(0);
  });

  test("didClose passes correct textDocument params shape to invoke", async () => {
    const adapter = makeFakeAdapter();
    const didCloseCalls: unknown[] = [];
    adapter.notifyTextDocumentDidClose = (params: unknown) => {
      didCloseCalls.push(params);
    };

    await invokeLspHandler(handlerMetadata.didClose, adapter, { uri: "file:///close-me.ts" });

    expect(didCloseCalls[0]).toEqual({
      textDocument: { uri: "file:///close-me.ts" },
    });
  });

  test("didOpen invokes notifyTextDocumentDidOpen (custom invoke path)", async () => {
    const adapter = makeFakeAdapter();
    const notifyTextDocumentDidOpenCalls: unknown[] = [];
    adapter.notifyTextDocumentDidOpen = (params: unknown) => {
      notifyTextDocumentDidOpenCalls.push(params);
    };

    const args = {
      workspaceId: "ws-1",
      workspaceRoot: "/ws",
      uri: "file:///open.ts",
      languageId: "typescript",
      version: 1,
      text: "const x = 1;",
    };
    const result = await invokeLspHandler(handlerMetadata.didOpen, adapter, args);

    expect(notifyTextDocumentDidOpenCalls).toHaveLength(1);
    expect(result).toBeNull();
    // generic notify/request paths should NOT have been called
    expect(adapter.notifyCalls).toHaveLength(0);
    expect(adapter.requestCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseHandlerOutput — valid inputs
// ---------------------------------------------------------------------------

describe("parseHandlerOutput — valid inputs", () => {
  test("hover: valid HoverResult passes schema", () => {
    const raw = { contents: "hover text" };
    const result = parseHandlerOutput(handlerMetadata.hover, raw);
    expect(result).toEqual({ contents: "hover text" });
  });

  test("hover: null passes nullable schema", () => {
    const result = parseHandlerOutput(handlerMetadata.hover, null);
    expect(result).toBeNull();
  });

  test("definition: array of Location passes schema", () => {
    const raw = [
      {
        uri: "file:///def.ts",
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 5 },
        },
      },
    ];
    const result = parseHandlerOutput(handlerMetadata.definition, raw);
    expect(result).toEqual(raw);
  });

  test("definition: LocationLink is normalized to Location by transform", () => {
    const raw = [
      {
        targetUri: "file:///def.ts",
        targetRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        targetSelectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
    ];
    const result = parseHandlerOutput(handlerMetadata.definition, raw) as { uri: string }[];
    expect(result).toHaveLength(1);
    expect(result[0].uri).toBe("file:///def.ts");
  });

  test("completion: valid CompletionItem array passes schema", () => {
    const raw = [{ label: "myMethod", kind: 2 }];
    const result = parseHandlerOutput(handlerMetadata.completion, raw);
    expect(result).toEqual([{ label: "myMethod", kind: 2 }]);
  });

  test("completion: CompletionList is normalized to item array by transform", () => {
    const raw = { items: [{ label: "completionA" }, { label: "completionB" }] };
    const result = parseHandlerOutput(handlerMetadata.completion, raw) as unknown[];
    expect(result).toHaveLength(2);
  });

  test("references: array of Location passes schema", () => {
    const raw = [
      {
        uri: "file:///ref.ts",
        range: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
      },
    ];
    const result = parseHandlerOutput(handlerMetadata.references, raw);
    expect(result).toEqual(raw);
  });

  test("documentSymbol: valid hierarchical symbol array passes schema", () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } };
    const raw = [{ name: "MyClass", kind: 5, range, selectionRange: range }];
    const result = parseHandlerOutput(handlerMetadata.documentSymbol, raw);
    expect(result).toEqual(raw);
  });

  test("didChange: null passes VoidResultSchema (notify handlers emit null)", () => {
    const result = parseHandlerOutput(handlerMetadata.didChange, null);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseHandlerOutput — invalid inputs (schema violations → throw)
// ---------------------------------------------------------------------------

describe("parseHandlerOutput — normalizer behavior and schema enforcement", () => {
  // hover has normalizeHoverResult as transform. The normalizer returns null for
  // unrecognizable input, and HoverResultSchema is nullable — so bad input → null,
  // not a throw.
  test("hover: non-object raw value → normalizer returns null → passes nullable schema", () => {
    const result = parseHandlerOutput(handlerMetadata.hover, "bad input");
    expect(result).toBeNull();
  });

  test("hover: object missing contents → normalizer returns null → passes nullable schema", () => {
    const result = parseHandlerOutput(handlerMetadata.hover, { range: {} });
    expect(result).toBeNull();
  });

  test("hover: { contents: 123 } → normalizer returns null → passes nullable schema", () => {
    const result = parseHandlerOutput(handlerMetadata.hover, { contents: 123 });
    expect(result).toBeNull();
  });

  test("definition: null → normalizeDefinitionResult returns [] → passes array schema", () => {
    const result = parseHandlerOutput(handlerMetadata.definition, null);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test("definition: array with invalid items → filtered to [] by normalizer", () => {
    const raw = [{ notAUri: "bad" }];
    const result = parseHandlerOutput(handlerMetadata.definition, raw) as unknown[];
    expect(result).toHaveLength(0);
  });

  test("completion: non-array string → normalizer returns [] → passes array schema", () => {
    const result = parseHandlerOutput(handlerMetadata.completion, "invalid") as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test("completion: items with missing label are filtered out", () => {
    const raw = { items: [{ label: "valid" }, { sortText: "invalid" }] };
    const result = parseHandlerOutput(handlerMetadata.completion, raw) as unknown[];
    expect(result).toHaveLength(1);
  });

  test("documentSymbol: plain object → normalizer warns and returns [] → passes schema", () => {
    const result = parseHandlerOutput(handlerMetadata.documentSymbol, { notAnArray: true }) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test("references: array with invalid location shape → filtered to [] by normalizer", () => {
    const raw = [{ badField: "x" }];
    const result = parseHandlerOutput(handlerMetadata.references, raw) as unknown[];
    expect(result).toHaveLength(0);
  });

  test("workspaceSymbol: items missing required 'kind' field are filtered out", () => {
    const raw = [
      { name: "BadSymbol" },
      {
        name: "GoodSymbol",
        kind: 12,
        location: {
          uri: "file:///ws/sym.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      },
    ];
    const result = parseHandlerOutput(handlerMetadata.workspaceSymbol, raw) as unknown[];
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fsChangeKindToLspType
// ---------------------------------------------------------------------------

describe("fsChangeKindToLspType", () => {
  test('"added" maps to FileChangeType.Created', () => {
    const result: FileEvent["type"] = fsChangeKindToLspType("added");
    expect(result).toBe(FileChangeType.Created);
  });

  test('"deleted" maps to FileChangeType.Deleted', () => {
    const result: FileEvent["type"] = fsChangeKindToLspType("deleted");
    expect(result).toBe(FileChangeType.Deleted);
  });

  test('"modified" maps to FileChangeType.Changed (default fallback)', () => {
    const result: FileEvent["type"] = fsChangeKindToLspType("modified");
    expect(result).toBe(FileChangeType.Changed);
  });

  test("FileChangeType values are correct LSP integers", () => {
    expect(FileChangeType.Created).toBe(1);
    expect(FileChangeType.Changed).toBe(2);
    expect(FileChangeType.Deleted).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// handlerMetadata catalog — inSchema parse samples
// ---------------------------------------------------------------------------

describe("handlerMetadata catalog — inSchema samples", () => {
  test("hover inSchema accepts uri + line + character", () => {
    const result = handlerMetadata.hover.inSchema.safeParse({
      uri: "file:///test.ts",
      line: 4,
      character: 12,
    });
    expect(result.success).toBe(true);
  });

  test("hover inSchema rejects missing uri", () => {
    const result = handlerMetadata.hover.inSchema.safeParse({ line: 0, character: 0 });
    expect(result.success).toBe(false);
  });

  test("definition inSchema accepts TextDocumentPositionArgs", () => {
    const result = handlerMetadata.definition.inSchema.safeParse({
      uri: "file:///def.ts",
      line: 1,
      character: 5,
    });
    expect(result.success).toBe(true);
  });

  test("references inSchema accepts uri + line + character + includeDeclaration", () => {
    const result = handlerMetadata.references.inSchema.safeParse({
      uri: "file:///refs.ts",
      line: 2,
      character: 3,
      includeDeclaration: true,
    });
    expect(result.success).toBe(true);
  });

  test("references inSchema rejects missing includeDeclaration", () => {
    const result = handlerMetadata.references.inSchema.safeParse({
      uri: "file:///refs.ts",
      line: 0,
      character: 0,
    });
    expect(result.success).toBe(false);
  });

  test("completion inSchema accepts TextDocumentPositionArgs", () => {
    const result = handlerMetadata.completion.inSchema.safeParse({
      uri: "file:///comp.ts",
      line: 7,
      character: 3,
    });
    expect(result.success).toBe(true);
  });

  test("documentSymbol inSchema accepts TextDocumentIdentifier", () => {
    const result = handlerMetadata.documentSymbol.inSchema.safeParse({
      uri: "file:///sym.ts",
    });
    expect(result.success).toBe(true);
  });

  test("workspaceSymbol inSchema accepts workspaceId + query", () => {
    const result = handlerMetadata.workspaceSymbol.inSchema.safeParse({
      workspaceId: "ws-abc",
      query: "MyClass",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handlerMetadata catalog — lspMethod and kind correctness
// ---------------------------------------------------------------------------

describe("handlerMetadata catalog — lspMethod and kind values", () => {
  test("hover is a request to textDocument/hover", () => {
    expect(handlerMetadata.hover.kind).toBe("request");
    expect(handlerMetadata.hover.lspMethod).toBe("textDocument/hover");
  });

  test("definition is a request to textDocument/definition", () => {
    expect(handlerMetadata.definition.kind).toBe("request");
    expect(handlerMetadata.definition.lspMethod).toBe("textDocument/definition");
  });

  test("completion is a request to textDocument/completion", () => {
    expect(handlerMetadata.completion.kind).toBe("request");
    expect(handlerMetadata.completion.lspMethod).toBe("textDocument/completion");
  });

  test("references is a request to textDocument/references", () => {
    expect(handlerMetadata.references.kind).toBe("request");
    expect(handlerMetadata.references.lspMethod).toBe("textDocument/references");
  });

  test("didOpen is a notify to textDocument/didOpen", () => {
    expect(handlerMetadata.didOpen.kind).toBe("notify");
    expect(handlerMetadata.didOpen.lspMethod).toBe("textDocument/didOpen");
  });

  test("didChange is a notify to textDocument/didChange", () => {
    expect(handlerMetadata.didChange.kind).toBe("notify");
    expect(handlerMetadata.didChange.lspMethod).toBe("textDocument/didChange");
  });

  test("didClose is a notify to textDocument/didClose", () => {
    expect(handlerMetadata.didClose.kind).toBe("notify");
    expect(handlerMetadata.didClose.lspMethod).toBe("textDocument/didClose");
  });

  test("documentSymbol is a request to textDocument/documentSymbol", () => {
    expect(handlerMetadata.documentSymbol.kind).toBe("request");
    expect(handlerMetadata.documentSymbol.lspMethod).toBe("textDocument/documentSymbol");
  });
});
