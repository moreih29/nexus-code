// Generic stdio LSP adapter.
// Spawns a configured language server process and bridges JSON-RPC over stdio.

import { type ChildProcess, spawn } from "node:child_process";
import type { LspServerSpec } from "../../../shared/lsp-config";
import {
  type ServerCapabilities,
  TextDocumentSyncKind,
  type TextDocumentContentChangeEvent,
} from "../../../shared/lsp-types";
import { LSP_DISPOSE_GRACE_MS } from "../../../shared/timing-constants";
import { resolveBundledBinary } from "../resolve-bundled-binary";
import {
  type JsonRpcId,
  encodeMessage,
  jsonRpcId,
  isObjectLike,
  capabilityValueIsSupported,
} from "./json-rpc-codec";
import {
  initializeResultCapabilities,
  negotiatedTextDocumentSyncKind,
  negotiatedTextDocumentOpenClose,
  negotiatedTextDocumentSave,
} from "./lsp-capability-negotiation";
import { applyTextDocumentContentChanges } from "./text-document-changes";

export type { LspServerSpec } from "../../../shared/lsp-config";
export { applyTextDocumentContentChanges } from "./text-document-changes";
export {
  negotiatedTextDocumentSyncKind,
  negotiatedTextDocumentOpenClose,
  negotiatedTextDocumentSave,
} from "./lsp-capability-negotiation";

export interface LspRequestOptions {
  signal?: AbortSignal;
}

export type ServerNotificationHandler = (params: unknown) => void | Promise<void>;
export type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

export interface DidOpenTextDocumentParams {
  textDocument: {
    uri: string;
    languageId: string;
    version: number;
    text: string;
  };
}

export interface DidChangeTextDocumentParams {
  textDocument: {
    uri: string;
    version: number | null;
  };
  contentChanges: TextDocumentContentChangeEvent[];
}

export interface DidCloseTextDocumentParams {
  textDocument: {
    uri: string;
  };
}

export interface DidSaveTextDocumentParams {
  textDocument: {
    uri: string;
  };
  text?: string;
}

export interface LspAdapter {
  start(): Promise<void>;
  request<TIn = unknown, TOut = unknown>(
    method: string,
    params: TIn,
    opts?: LspRequestOptions,
  ): Promise<TOut>;
  notify(method: string, params: unknown): void;
  notifyTextDocumentDidOpen(params: DidOpenTextDocumentParams): void;
  notifyTextDocumentDidChange(params: DidChangeTextDocumentParams): void;
  notifyTextDocumentDidClose(params: DidCloseTextDocumentParams): void;
  notifyTextDocumentDidSave(params: DidSaveTextDocumentParams): void;
  onServerNotification(method: string, handler: ServerNotificationHandler): void;
  onServerRequest(method: string, handler: ServerRequestHandler): void;
  hasCapability(key: string, sub?: string): boolean;
  dispose(): void;
}

export class StdioLspAdapter implements LspAdapter {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void }
  >();
  private serverCapabilities: ServerCapabilities = {};
  private readonly textDocumentCache = new Map<string, string>();
  private serverNotificationHandlers = new Map<string, ServerNotificationHandler>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private disposed = false;

  constructor(
    private readonly spec: LspServerSpec,
    private readonly workspaceId: string,
    private readonly workspaceRootUri: string | null,
  ) {}

  private get logPrefix(): string {
    const label = this.spec.languageId === "typescript" ? "ts" : this.spec.languageId;
    return `[lsp-${label}:${this.workspaceId}]`;
  }

  async start(): Promise<void> {
    const binaryPath = resolveBundledBinary(this.spec.binary);

    this.proc = spawn(binaryPath, this.spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // biome-ignore lint/style/noNonNullAssertion: stdio:'pipe' guarantees stdout is non-null
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    // biome-ignore lint/style/noNonNullAssertion: stdio:'pipe' guarantees stderr is non-null
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`${this.logPrefix} ${chunk}`);
    });
    this.proc.on("exit", (code) => {
      if (!this.disposed) {
        console.warn(`${this.logPrefix} exited with code ${code}`);
      }
      for (const [, p] of this.pending) {
        p.cleanup();
        p.reject(new Error(`${this.spec.binary} process exited`));
      }
      this.pending.clear();
    });

    await this.sendInitialize();
  }

  private async sendInitialize(): Promise<void> {
    const workspaceRoot = this.workspaceRootUri;
    const workspaceFields =
      workspaceRoot !== null
        ? {
            workspaceFolders: [
              {
                uri: workspaceRoot,
                name: this.workspaceId,
              },
            ],
          }
        : {};

    const initializeResult = await this.request("initialize", {
      processId: process.pid,
      rootUri: workspaceRoot,
      ...workspaceFields,
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
          references: { dynamicRegistration: false },
          documentHighlight: { dynamicRegistration: false },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
          },
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
          symbol: { dynamicRegistration: false },
        },
      },
      initializationOptions: this.spec.initializationOptions ?? {},
    });
    this.serverCapabilities = initializeResultCapabilities(initializeResult);
    this.notify("initialized", {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.textDocumentCache.clear();
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            this.proc?.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, LSP_DISPOSE_GRACE_MS);
      } catch {
        /* ignore */
      }
    }
  }

  request<TIn = unknown, TOut = unknown>(
    method: string,
    params: TIn,
    opts: LspRequestOptions = {},
  ): Promise<TOut> {
    return new Promise<TOut>((resolve, reject) => {
      if (this.disposed || !this.proc) {
        reject(new Error("server disposed"));
        return;
      }
      const id = this.nextId++;
      const signal = opts.signal;
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;

        this.pending.delete(id);
        pending.cleanup();
        this.sendCancelRequest(id);
        pending.reject(abortError());
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      if (signal && !signal.aborted) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, { resolve: (value) => resolve(value as TOut), reject, cleanup });
      const msg = { jsonrpc: "2.0", id, method, params };
      this.sendMessage(msg);
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  notifyTextDocumentDidOpen(params: DidOpenTextDocumentParams): void {
    this.textDocumentCache.set(params.textDocument.uri, params.textDocument.text);
    if (!negotiatedTextDocumentOpenClose(this.serverCapabilities)) return;
    this.notify("textDocument/didOpen", params);
  }

  notifyTextDocumentDidChange(params: DidChangeTextDocumentParams): void {
    const kind = negotiatedTextDocumentSyncKind(this.serverCapabilities);
    if (kind === TextDocumentSyncKind.None) return;

    const uri = params.textDocument.uri;
    const existingText = this.textDocumentCache.get(uri);
    const nextText =
      existingText === undefined
        ? this.reconstructMissingCache(params.contentChanges)
        : applyTextDocumentContentChanges(existingText, params.contentChanges);

    if (nextText !== undefined) {
      this.textDocumentCache.set(uri, nextText);
    }

    if (kind === TextDocumentSyncKind.Incremental) {
      this.notify("textDocument/didChange", params);
      return;
    }

    if (nextText === undefined) return;
    this.notify("textDocument/didChange", {
      textDocument: params.textDocument,
      contentChanges: [{ text: nextText }],
    });
  }

  notifyTextDocumentDidClose(params: DidCloseTextDocumentParams): void {
    this.textDocumentCache.delete(params.textDocument.uri);
    if (!negotiatedTextDocumentOpenClose(this.serverCapabilities)) return;
    this.notify("textDocument/didClose", params);
  }

  notifyTextDocumentDidSave(params: DidSaveTextDocumentParams): void {
    const save = negotiatedTextDocumentSave(this.serverCapabilities);
    if (!save.supported) return;

    this.notify("textDocument/didSave", {
      textDocument: params.textDocument,
      ...(save.includeText && params.text !== undefined ? { text: params.text } : {}),
    });
  }

  onServerNotification(method: string, handler: ServerNotificationHandler): void {
    this.serverNotificationHandlers.set(method, handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  hasCapability(key: string, sub?: string): boolean {
    const value = this.serverCapabilities[key];
    if (sub === undefined) return capabilityValueIsSupported(value);
    if (value === true) return true;
    if (!isObjectLike(value)) return false;
    return capabilityValueIsSupported(value[sub]);
  }

  private reconstructMissingCache(
    contentChanges: readonly TextDocumentContentChangeEvent[],
  ): string | undefined {
    for (const change of contentChanges) {
      if (!("range" in change)) return change.text;
    }
    return undefined;
  }

  private sendMessage(msg: unknown): void {
    if (this.disposed || !this.proc) return;
    // biome-ignore lint/style/noNonNullAssertion: stdio:'pipe' guarantees stdin is non-null
    this.proc.stdin!.write(encodeMessage(msg));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseMessages();
  }

  private parseMessages(): void {
    while (true) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep === -1) break;

      const header = this.buffer.slice(0, sep).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(sep + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = sep + 4;
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }

      this.handleMessage(msg as Record<string, unknown>);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      if (typeof msg.id !== "number") return;
      const id = msg.id;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.cleanup();
        if (msg.error) {
          const err = msg.error as { message?: string };
          pending.reject(new Error(err.message ?? "LSP error"));
        } else {
          pending.resolve(msg.result ?? null);
        }
      }
      return;
    }

    if ("id" in msg && typeof msg.method === "string") {
      this.handleServerRequest(jsonRpcId(msg.id), msg.method, msg.params);
      return;
    }

    if (!("id" in msg) && typeof msg.method === "string") {
      this.handleServerNotification(msg.method, msg.params);
    }
  }

  private handleServerNotification(method: string, params: unknown): void {
    const handler = this.serverNotificationHandlers.get(method);
    if (!handler) return;

    try {
      Promise.resolve(handler(params)).catch((err: unknown) => {
        console.warn(`${this.logPrefix} server notification handler failed`, err);
      });
    } catch (err) {
      console.warn(`${this.logPrefix} server notification handler failed`, err);
    }
  }

  private async handleServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      this.sendErrorResponse(id, -32601, "Method not found");
      return;
    }

    try {
      const result = await handler(params);
      this.sendResultResponse(id, result ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendErrorResponse(id, -32603, message);
    }
  }

  private sendResultResponse(id: JsonRpcId, result: unknown): void {
    this.sendMessage({ jsonrpc: "2.0", id, result });
  }

  private sendErrorResponse(id: JsonRpcId, code: number, message: string): void {
    this.sendMessage({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  private sendCancelRequest(id: number): void {
    this.sendMessage({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id },
    });
  }
}

function abortError(): Error {
  const err = new Error("Request cancelled");
  err.name = "AbortError";
  return err;
}
