// AgentLspServer is the per-LSP-instance handle the host hands out. It
// owns the request id sequence, the textDocument cache used for
// Full-sync downgrade, and the channel send envelope. The host class
// keeps the lifecycle map (workspaceId → languageId → server); this
// class is intentionally ignorant of how it is registered.

import { type ServerCapabilities, TextDocumentSyncKind } from "../../../shared/lsp";
import type { TextDocumentContentChangeEvent } from "../../../shared/lsp";
import type { AgentChannel } from "../../infra/agent/channel";
import type { LspHostCallOptions } from "./host";
import {
  capabilityValueIsSupported,
  negotiatedTextDocumentOpenClose,
  negotiatedTextDocumentSave,
  negotiatedTextDocumentSyncKind,
} from "./lsp-capability-negotiation";
import {
  applyTextDocumentContentChanges,
  reconstructMissingCache,
} from "./lsp-content-change";
import { abortError, asRecord, isObjectLike, jsonRpcId, lspError } from "./lsp-utils";

type PendingRequestId = string | number;

interface PendingClientRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class AgentLspServer {
  private readonly pending = new Map<PendingRequestId, PendingClientRequest>();
  private readonly textDocumentCache = new Map<string, string>();
  private nextRequestId = 1;
  private disposed = false;

  readonly channel: AgentChannel;
  readonly serverId: string;
  readonly workspaceId: string;
  readonly languageId: string;
  private readonly capabilities: ServerCapabilities;

  constructor(options: {
    channel: AgentChannel;
    serverId: string;
    workspaceId: string;
    languageId: string;
    capabilities: ServerCapabilities;
  }) {
    this.channel = options.channel;
    this.serverId = options.serverId;
    this.workspaceId = options.workspaceId;
    this.languageId = options.languageId;
    this.capabilities = options.capabilities;
  }

  request(method: string, params: unknown, opts: LspHostCallOptions = {}): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("server disposed"));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        void this.channel.call("lsp.cancel", { serverId: this.serverId, requestId: id });
        pending.reject(abortError());
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      if (signal && !signal.aborted) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, { resolve, reject, cleanup });
      this.sendMessage({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.disposed) return;
    await this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  async notifyTextDocumentDidOpen(params: {
    textDocument: { uri: string; languageId: string; version: number; text: string };
  }): Promise<void> {
    this.textDocumentCache.set(params.textDocument.uri, params.textDocument.text);
    if (!negotiatedTextDocumentOpenClose(this.capabilities)) return;
    await this.notify("textDocument/didOpen", params);
  }

  async notifyTextDocumentDidChange(params: {
    textDocument: { uri: string; version: number | null };
    contentChanges: TextDocumentContentChangeEvent[];
  }): Promise<void> {
    const kind = negotiatedTextDocumentSyncKind(this.capabilities);
    if (kind === TextDocumentSyncKind.None) return;

    const uri = params.textDocument.uri;
    const existingText = this.textDocumentCache.get(uri);
    const nextText =
      existingText === undefined
        ? reconstructMissingCache(params.contentChanges)
        : applyTextDocumentContentChanges(existingText, params.contentChanges);

    if (nextText !== undefined) {
      this.textDocumentCache.set(uri, nextText);
    }

    if (kind === TextDocumentSyncKind.Incremental) {
      await this.notify("textDocument/didChange", params);
      return;
    }

    if (nextText === undefined) return;
    await this.notify("textDocument/didChange", {
      textDocument: params.textDocument,
      contentChanges: [{ text: nextText }],
    });
  }

  async notifyTextDocumentDidClose(params: { textDocument: { uri: string } }): Promise<void> {
    this.textDocumentCache.delete(params.textDocument.uri);
    if (!negotiatedTextDocumentOpenClose(this.capabilities)) return;
    await this.notify("textDocument/didClose", params);
  }

  async notifyTextDocumentDidSave(params: {
    textDocument: { uri: string };
    text?: string;
  }): Promise<void> {
    const save = negotiatedTextDocumentSave(this.capabilities);
    if (!save.supported) return;

    await this.notify("textDocument/didSave", {
      textDocument: params.textDocument,
      ...(save.includeText && params.text !== undefined ? { text: params.text } : {}),
    });
  }

  hasCapability(key: string, sub?: string): boolean {
    const value = this.capabilities[key];
    if (sub === undefined) return capabilityValueIsSupported(value);
    if (value === true) return true;
    if (!isObjectLike(value)) return false;
    return capabilityValueIsSupported(value[sub]);
  }

  handleMessage(message: unknown): boolean {
    const msg = asRecord(message);
    if (!msg || !("id" in msg) || (!("result" in msg) && !("error" in msg))) {
      return false;
    }

    const id = jsonRpcId(msg.id);
    if (typeof id !== "number" && typeof id !== "string") return false;
    const pending = this.pending.get(id);
    if (!pending) return false;

    this.pending.delete(id);
    pending.cleanup();
    if (msg.error) {
      pending.reject(lspError(msg.error));
    } else {
      pending.resolve(msg.result ?? null);
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.textDocumentCache.clear();
    for (const [, pending] of this.pending) {
      pending.cleanup();
      pending.reject(new Error("server disposed"));
    }
    this.pending.clear();
    void this.channel.call("lsp.shutdown", { serverId: this.serverId }).catch(() => {});
  }

  // disposePending mirrors dispose() but does not call lsp.shutdown — the
  // server already exited, so the agent no longer holds a serverId for it.
  // Used by the host's serverExited handler to fail in-flight requests.
  disposePending(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.textDocumentCache.clear();
    for (const [, pending] of this.pending) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async sendMessage(message: unknown): Promise<void> {
    await this.channel.call("lsp.send", { serverId: this.serverId, message });
  }
}
