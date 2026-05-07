// Shared test infrastructure for LspManager unit tests.

import { LspManager, type LspManagerOpts } from "../../../../src/utility/lsp-host/lsp-manager";
import type { LspAdapter } from "../../../../src/utility/lsp-host/servers/stdio-lsp-adapter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerNotificationHandler = (params: unknown) => void | Promise<void>;
export type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;
export type DeferredRequest = {
  method: string;
  signal?: AbortSignal;
  reject: (err: Error) => void;
  resolve: (value: unknown) => void;
};

export const lspRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 4 },
};

interface FakeLspServerSpec {
  languageId: string;
}

export type UriIndexEntry = { workspaceId: string; presetLanguageId: string };

// ---------------------------------------------------------------------------
// FakeStdioLspAdapter
// ---------------------------------------------------------------------------

export const adapterInstances: FakeStdioLspAdapter[] = [];

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

export class FakeStdioLspAdapter implements LspAdapter {
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
  readonly referencesUris: string[] = [];
  readonly documentHighlightUris: string[] = [];
  readonly documentSymbolUris: string[] = [];
  readonly workspaceSymbolQueries: string[] = [];
  readonly requestMethods: string[] = [];
  readonly notificationMethods: string[] = [];
  readonly notificationParams: unknown[] = [];
  readonly capabilities = new Set([
    "hoverProvider",
    "definitionProvider",
    "completionProvider",
    "referencesProvider",
    "documentHighlightProvider",
    "documentSymbolProvider",
    "workspaceSymbolProvider",
  ]);
  syncKind = 2;
  saveSupported = false;
  saveIncludeText = false;
  readonly notificationHandlers = new Map<string, ServerNotificationHandler>();
  readonly requestHandlers = new Map<string, ServerRequestHandler>();
  readonly deferredMethods = new Set<string>();
  readonly deferredRequests: DeferredRequest[] = [];
  readonly failingMethods = new Set<string>();
  documentHighlightResult: unknown = [{ range: lspRange, kind: 3 }];
  documentSymbolResult: unknown = [
    {
      name: "FakeClass",
      kind: 5,
      range: lspRange,
      selectionRange: lspRange,
      children: [{ name: "method", kind: 6, range: lspRange, selectionRange: lspRange }],
    },
  ];
  workspaceSymbolResult: unknown | undefined;

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
    if (this.failingMethods.has(method)) {
      throw new Error(`${method} failed for ${this.workspaceId}`);
    }
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
          targetRange: lspRange,
          targetSelectionRange: lspRange,
        },
      ] as TOut;
    }
    if (method === "textDocument/completion") {
      this.completionUris.push(uri);
      return {
        items: [{ label: `fakeCompletion ${this.workspaceId}` }, { sortText: "invalid" }],
      } as TOut;
    }
    if (method === "textDocument/references") {
      this.referencesUris.push(uri);
      return [{ targetUri: uri, targetRange: lspRange, targetSelectionRange: lspRange }] as TOut;
    }
    if (method === "textDocument/documentHighlight") {
      this.documentHighlightUris.push(uri);
      return this.documentHighlightResult as TOut;
    }
    if (method === "textDocument/documentSymbol") {
      this.documentSymbolUris.push(uri);
      return this.documentSymbolResult as TOut;
    }
    if (method === "workspace/symbol") {
      const query = (params as { query?: unknown }).query;
      this.workspaceSymbolQueries.push(typeof query === "string" ? query : "");
      return (this.workspaceSymbolResult ?? [
        {
          name: `WorkspaceSymbol ${this.workspaceId}`,
          kind: 12,
          location: {
            uri: `file:///${this.workspaceId}/symbol.ts`,
            range: lspRange,
          },
          containerName: this.languageId,
        },
      ]) as TOut;
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

// ---------------------------------------------------------------------------
// FakePort
// ---------------------------------------------------------------------------

export class FakePort {
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

export const FAST_IDLE_MS = 30;
// Conservative pad so the idle timer always fires before we assert.
export const IDLE_WAIT_MS = 100;

export function makeCallMsg(method: string, args: unknown, id: string | number = 1) {
  return { type: "call", id, method, args };
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function waitUntil(predicate: () => boolean, label: string): Promise<void> {
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

export function makeManager(opts: LspManagerOpts = {}): LspManager {
  return new LspManager({
    ...opts,
    adapterFactory:
      opts.adapterFactory ??
      ((spec, workspaceId, workspaceRootUri) =>
        new FakeStdioLspAdapter(spec, workspaceId, workspaceRootUri)),
  });
}

export function getUriIndex(manager: InstanceType<typeof LspManager>): Map<string, UriIndexEntry> {
  return (manager as unknown as { uriIndex: Map<string, UriIndexEntry> }).uriIndex;
}

export function adapterFor(workspaceId: string): FakeStdioLspAdapter {
  const adapter = adapterInstances.find((instance) => instance.workspaceId === workspaceId);
  if (!adapter) {
    throw new Error(`adapter not found for ${workspaceId}`);
  }
  return adapter;
}

export function adapterForLanguage(workspaceId: string, languageId: string): FakeStdioLspAdapter {
  const adapter = adapterInstances.find(
    (instance) => instance.workspaceId === workspaceId && instance.languageId === languageId,
  );
  if (!adapter) {
    throw new Error(`adapter not found for ${workspaceId}/${languageId}`);
  }
  return adapter;
}

export function serverRequestHandler(
  adapter: FakeStdioLspAdapter,
  method: string,
): ServerRequestHandler {
  const handler = adapter.requestHandlers.get(method);
  if (!handler) {
    throw new Error(`server request handler not found for ${method}`);
  }
  return handler;
}

export function serverNotificationHandler(
  adapter: FakeStdioLspAdapter,
  method: string,
): ServerNotificationHandler {
  const handler = adapter.notificationHandlers.get(method);
  if (!handler) {
    throw new Error(`server notification handler not found for ${method}`);
  }
  return handler;
}

export interface OpenFileOptions {
  workspaceRoot?: string;
  languageId?: string;
  version?: number;
  text?: string;
}

export async function openFile(
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
