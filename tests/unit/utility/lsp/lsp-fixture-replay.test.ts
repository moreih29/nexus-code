import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ipcContract } from "../../../../src/shared/ipc-contract";
import { LspManager } from "../../../../src/utility/lsp-host/lsp-manager";
import type { LspAdapter } from "../../../../src/utility/lsp-host/servers/stdio-lsp-adapter";

interface FixtureSnapshot {
  pyrightVersion: string;
  workspaceRoot: string;
  request: {
    method: string;
    params: unknown;
  };
  response: {
    jsonrpc: "2.0";
    id: string | number | null;
    result?: unknown;
    error?: unknown;
  };
}

interface CallMessage {
  type: "call";
  id: string | number;
  method: string;
  args: unknown;
}

const RESPONSE_DIR = resolve(import.meta.dir, "../../../fixtures/lsp/pyright/responses");
const WORKSPACE_ID = "pyright-fixture-replay";
const WORKSPACE_ROOT = "/__PYRIGHT_FIXTURE_WORKSPACE__";
const MODULE_A_URI = "file:///__PYRIGHT_FIXTURE_WORKSPACE__/module_a.py";

const fixtureNames = [
  "hover-module_a-greet",
  "definition-module_b-greeter",
  "completion-module_a-context",
  "references-module_a-class",
  "references-module_b-cross-file",
  "document-symbol-module_a",
  "document-highlight-module_a-readwrite",
  "workspace-symbol-greet",
] as const;

type FixtureName = (typeof fixtureNames)[number];

type ServerNotificationHandler = (params: unknown) => void | Promise<void>;
type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

class FakePort {
  private handlers: Array<(event: { data: unknown }) => void> = [];
  private listeners: Array<() => void> = [];
  readonly sent: unknown[] = [];

  on(_event: "message", handler: (event: { data: unknown }) => void): void {
    this.handlers.push(handler);
  }

  start(): void {}

  postMessage(data: unknown): void {
    this.sent.push(data);
    const listeners = this.listeners.splice(0);
    for (const listener of listeners) listener();
  }

  deliver(data: unknown): void {
    for (const handler of this.handlers) handler({ data });
  }

  waitForMessages(count: number): Promise<void> {
    return new Promise<void>((resolveWait, rejectWait) => {
      const bail = setTimeout(
        () => rejectWait(new Error(`waitForMessages(${count}) timed out, got ${this.sent.length}`)),
        3000,
      );
      const check = () => {
        if (this.sent.length >= count) {
          clearTimeout(bail);
          resolveWait();
          return;
        }
        this.listeners.push(check);
      };
      check();
    });
  }
}

class ReplayAdapter implements LspAdapter {
  started = false;
  disposed = false;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly capabilities = new Set([
    "hoverProvider",
    "definitionProvider",
    "completionProvider",
    "referencesProvider",
    "documentHighlightProvider",
    "documentSymbolProvider",
    "workspaceSymbolProvider",
  ]);
  readonly notificationHandlers = new Map<string, ServerNotificationHandler>();
  readonly requestHandlers = new Map<string, ServerRequestHandler>();

  constructor(private readonly resultByMethod: Map<string, unknown>) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async request<TIn = unknown, TOut = unknown>(method: string, params: TIn): Promise<TOut> {
    this.requests.push({ method, params });
    if (!this.resultByMethod.has(method)) {
      throw new Error(`No replay fixture for ${method}`);
    }
    return structuredClone(this.resultByMethod.get(method)) as TOut;
  }

  notify(_method: string, _params: unknown): void {}

  notifyTextDocumentDidOpen(params: Parameters<LspAdapter["notifyTextDocumentDidOpen"]>[0]): void {
    this.notify("textDocument/didOpen", params);
  }

  notifyTextDocumentDidChange(
    params: Parameters<LspAdapter["notifyTextDocumentDidChange"]>[0],
  ): void {
    this.notify("textDocument/didChange", params);
  }

  notifyTextDocumentDidClose(
    params: Parameters<LspAdapter["notifyTextDocumentDidClose"]>[0],
  ): void {
    this.notify("textDocument/didClose", params);
  }

  notifyTextDocumentDidSave(params: Parameters<LspAdapter["notifyTextDocumentDidSave"]>[0]): void {
    this.notify("textDocument/didSave", params);
  }

  onServerNotification(method: string, handler: ServerNotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  hasCapability(key: string): boolean {
    return this.capabilities.has(key);
  }

  dispose(): void {
    this.disposed = true;
  }
}

let manager: LspManager | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function loadFixture(name: FixtureName): FixtureSnapshot {
  return JSON.parse(readFileSync(resolve(RESPONSE_DIR, `${name}.json`), "utf8")) as FixtureSnapshot;
}

function makeCallMsg(method: string, args: unknown, id: string | number): CallMessage {
  return { type: "call", id, method, args };
}

function textDocumentUri(params: unknown): string {
  if (!isRecord(params) || !isRecord(params.textDocument)) {
    throw new Error("Fixture params missing textDocument");
  }
  const { uri } = params.textDocument;
  if (typeof uri !== "string") throw new Error("Fixture textDocument missing uri");
  return uri;
}

function position(params: unknown): { line: number; character: number } {
  if (!isRecord(params) || !isRecord(params.position)) {
    throw new Error("Fixture params missing position");
  }
  const { line, character } = params.position;
  if (typeof line !== "number" || typeof character !== "number") {
    throw new Error("Fixture position missing line/character");
  }
  return { line, character };
}

function includeDeclaration(params: unknown): boolean {
  if (!isRecord(params) || !isRecord(params.context)) {
    throw new Error("Fixture params missing references context");
  }
  const value = params.context.includeDeclaration;
  if (typeof value !== "boolean")
    throw new Error("Fixture references context missing includeDeclaration");
  return value;
}

function workspaceQuery(params: unknown): string {
  if (!isRecord(params) || typeof params.query !== "string") {
    throw new Error("Fixture params missing workspace symbol query");
  }
  return params.query;
}

function completionItems(result: unknown): unknown {
  if (Array.isArray(result)) return result;
  if (!isRecord(result) || !Array.isArray(result.items)) {
    throw new Error("Fixture completion result missing items");
  }
  return result.items;
}

function managerCallForFixture(fixture: FixtureSnapshot): { method: string; args: unknown } {
  const { method, params } = fixture.request;
  if (method === "textDocument/hover") {
    const pos = position(params);
    return {
      method: "hover",
      args: { uri: textDocumentUri(params), line: pos.line, character: pos.character },
    };
  }
  if (method === "textDocument/definition") {
    const pos = position(params);
    return {
      method: "definition",
      args: { uri: textDocumentUri(params), line: pos.line, character: pos.character },
    };
  }
  if (method === "textDocument/completion") {
    const pos = position(params);
    return {
      method: "completion",
      args: { uri: textDocumentUri(params), line: pos.line, character: pos.character },
    };
  }
  if (method === "textDocument/references") {
    const pos = position(params);
    return {
      method: "references",
      args: {
        uri: textDocumentUri(params),
        line: pos.line,
        character: pos.character,
        includeDeclaration: includeDeclaration(params),
      },
    };
  }
  if (method === "textDocument/documentHighlight") {
    const pos = position(params);
    return {
      method: "documentHighlight",
      args: { uri: textDocumentUri(params), line: pos.line, character: pos.character },
    };
  }
  if (method === "textDocument/documentSymbol") {
    return { method: "documentSymbol", args: { uri: textDocumentUri(params) } };
  }
  if (method === "workspace/symbol") {
    return {
      method: "workspaceSymbol",
      args: { workspaceId: WORKSPACE_ID, query: workspaceQuery(params) },
    };
  }
  throw new Error(`Unsupported fixture request method ${method}`);
}

async function openPythonDocument(port: FakePort, uri: string, id: string | number): Promise<void> {
  const expected = port.sent.length + 1;
  port.deliver(
    makeCallMsg(
      "didOpen",
      {
        workspaceId: WORKSPACE_ID,
        workspaceRoot: WORKSPACE_ROOT,
        uri,
        languageId: "python",
        version: 1,
        text: "",
      },
      id,
    ),
  );
  await port.waitForMessages(expected);
}

function contractResultSchema(method: string) {
  if (method === "hover") return ipcContract.lsp.call.hover.result;
  if (method === "definition") return ipcContract.lsp.call.definition.result;
  if (method === "completion") return ipcContract.lsp.call.completion.result;
  if (method === "references") return ipcContract.lsp.call.references.result;
  if (method === "documentHighlight") return ipcContract.lsp.call.documentHighlight.result;
  if (method === "documentSymbol") return ipcContract.lsp.call.documentSymbol.result;
  if (method === "workspaceSymbol") return ipcContract.lsp.call.workspaceSymbol.result;
  throw new Error(`No contract result schema for ${method}`);
}

function expectedManagerResult(callMethod: string, fixtureResult: unknown): unknown {
  if (callMethod === "completion") {
    return contractResultSchema(callMethod).parse(completionItems(fixtureResult));
  }
  return contractResultSchema(callMethod).parse(fixtureResult);
}

afterEach(() => {
  manager?.disposeAll();
  manager = undefined;
});

describe("Pyright LSP fixture replay", () => {
  for (const fixtureName of fixtureNames) {
    test(`${fixtureName} replays through LspManager schemas`, async () => {
      const fixture = loadFixture(fixtureName);
      const call = managerCallForFixture(fixture);
      const resultByMethod = new Map([[fixture.request.method, fixture.response.result]]);
      const adapters: ReplayAdapter[] = [];
      manager = new LspManager({
        idleTimeoutMs: 30_000,
        adapterFactory: () => {
          const adapter = new ReplayAdapter(resultByMethod);
          adapters.push(adapter);
          return adapter;
        },
      });
      const port = new FakePort();
      manager.attachPort(port);

      const uri =
        call.method === "workspaceSymbol" ? MODULE_A_URI : textDocumentUri(fixture.request.params);
      await openPythonDocument(port, uri, "open");

      port.deliver(makeCallMsg(call.method, call.args, "replay"));
      await port.waitForMessages(2);

      const expectedResult = expectedManagerResult(call.method, fixture.response.result);

      expect(adapters).toHaveLength(1);
      expect(adapters[0].started).toBe(true);
      expect(adapters[0].requests).toEqual([
        {
          method: fixture.request.method,
          params: fixture.request.params,
        },
      ]);
      expect(port.sent[1]).toEqual({
        type: "response",
        id: "replay",
        result: expectedResult,
      });
      expect(contractResultSchema(call.method).safeParse(expectedResult).success).toBe(true);
      expect(fixture.pyrightVersion).toBe("1.1.409");
      expect(fixture.workspaceRoot).toBe("file:///__PYRIGHT_FIXTURE_WORKSPACE__");
    });
  }
});
