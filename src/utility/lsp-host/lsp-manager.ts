// LSP manager — owns language server adapter instances per workspace/language.
// Runs inside the lsp-host utility process; communicates with the main process
// via MessagePort set up by lspHost.ts in the main process.
//
// Lifecycle: lazy spawn on first didOpen, 30-minute idle graceful shutdown.

import { absolutePathToFileUri } from "../../shared/file-uri";
import { resolveLspPreset, resolveLspPresetLanguageId } from "../../shared/lsp-config";
import { type LspAdapter, StdioLspAdapter } from "./servers/stdio-lsp-adapter";

// Inbound message shapes (main → utility)
interface CallMsg {
  type: "call";
  id: string | number;
  method: string;
  args: unknown;
}

type InboundMsg = CallMsg;

interface DidOpenArgs {
  workspaceId: string;
  workspaceRoot: string;
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

interface UriIndexEntry {
  workspaceId: string;
  presetLanguageId: string;
}

// MessagePort structural type (no electron import in utility)
interface IMessagePort {
  on: (event: "message", handler: (e: { data: unknown }) => void) => void;
  start: () => void;
  postMessage: (data: unknown) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface LspManagerOpts {
  /** Override the idle shutdown timeout. Defaults to 30 minutes; only set in tests. */
  idleTimeoutMs?: number;
}

export class LspManager {
  private port: IMessagePort | null = null;
  // keyed by workspaceId, then preset languageId
  private adapters = new Map<string, Map<string, LspAdapter>>();
  // keyed by workspaceId, then preset languageId — timer handle for idle shutdown
  private idleTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  private uriIndex = new Map<string, UriIndexEntry>();
  private readonly idleTimeoutMs: number;

  constructor(opts: LspManagerOpts = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  attachPort(port: IMessagePort): void {
    this.port = port;
    port.on("message", (event) => {
      this.handleMessage(event.data as InboundMsg);
    });
    port.start();
  }

  private send(msg: unknown): void {
    if (this.port) {
      this.port.postMessage(msg);
    }
  }

  private handleMessage(msg: InboundMsg): void {
    if (msg.type === "call") {
      this.handleCall(msg).catch((err: unknown) => {
        this.send({
          type: "response",
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private async handleCall(msg: CallMsg): Promise<void> {
    const { id, method, args } = msg;
    const a = args as Record<string, unknown>;

    switch (method) {
      case "didOpen": {
        const { workspaceId, workspaceRoot, uri, languageId, version, text } = args as DidOpenArgs;
        const presetLanguageId = resolveLspPresetLanguageId(languageId);
        const adapter = presetLanguageId
          ? await this.getOrCreateAdapter(workspaceId, languageId, workspaceRoot)
          : null;
        if (adapter && presetLanguageId) {
          this.resetIdleTimer(workspaceId, presetLanguageId);
          await adapter.didOpen(uri, languageId, version, text);
          this.uriIndex.set(uri, { workspaceId, presetLanguageId });
        }
        this.send({ type: "response", id, result: null });
        break;
      }
      case "didChange": {
        const uri = a.uri as string;
        const routed = this.findAdapterForUri(uri);
        if (routed) {
          this.resetIdleTimer(routed.workspaceId, routed.languageId);
          await routed.adapter.didChange(uri, a.version as number, a.text as string);
        }
        this.send({ type: "response", id, result: null });
        break;
      }
      case "didClose": {
        const uri = a.uri as string;
        const routed = this.findAdapterForUri(uri);
        if (routed) {
          this.resetIdleTimer(routed.workspaceId, routed.languageId);
          await routed.adapter.didClose(uri);
        }
        this.uriIndex.delete(uri);
        this.send({ type: "response", id, result: null });
        break;
      }
      case "hover": {
        const uri = a.uri as string;
        const routed = this.findAdapterForUri(uri);
        if (routed) {
          this.resetIdleTimer(routed.workspaceId, routed.languageId);
          const result = await routed.adapter.hover(uri, a.line as number, a.character as number);
          this.send({ type: "response", id, result });
        } else {
          this.send({ type: "response", id, result: null });
        }
        break;
      }
      case "definition": {
        const uri = a.uri as string;
        const routed = this.findAdapterForUri(uri);
        if (routed) {
          this.resetIdleTimer(routed.workspaceId, routed.languageId);
          const result = await routed.adapter.definition(
            uri,
            a.line as number,
            a.character as number,
          );
          this.send({ type: "response", id, result });
        } else {
          this.send({ type: "response", id, result: [] });
        }
        break;
      }
      case "completion": {
        const uri = a.uri as string;
        const routed = this.findAdapterForUri(uri);
        if (routed) {
          this.resetIdleTimer(routed.workspaceId, routed.languageId);
          const result = await routed.adapter.completion(
            uri,
            a.line as number,
            a.character as number,
          );
          this.send({ type: "response", id, result });
        } else {
          this.send({ type: "response", id, result: [] });
        }
        break;
      }
      default:
        this.send({ type: "response", id, error: `unknown method: ${method}` });
    }
  }

  private async getOrCreateAdapter(
    workspaceId: string,
    languageId: string,
    workspaceRoot: string,
  ): Promise<LspAdapter | null> {
    const preset = resolveLspPreset(languageId);
    const presetLanguageId = resolveLspPresetLanguageId(languageId);
    if (!preset || !presetLanguageId) return null;

    let workspaceAdapters = this.adapters.get(workspaceId);
    if (!workspaceAdapters) {
      workspaceAdapters = new Map<string, LspAdapter>();
      this.adapters.set(workspaceId, workspaceAdapters);
    }

    let adapter = workspaceAdapters.get(presetLanguageId);
    if (!adapter) {
      adapter = new StdioLspAdapter(
        preset,
        workspaceId,
        absolutePathToFileUri(workspaceRoot),
        (uri, diagnostics) => {
          this.send({ type: "diagnostics", uri, diagnostics });
        },
      );
      await adapter.start();
      workspaceAdapters.set(presetLanguageId, adapter);
    }
    return adapter;
  }

  private findAdapterForUri(uri: string):
    | {
        workspaceId: string;
        languageId: string;
        adapter: LspAdapter;
      }
    | undefined {
    const entry = this.uriIndex.get(uri);
    if (!entry) return undefined;
    const adapter = this.adapters.get(entry.workspaceId)?.get(entry.presetLanguageId);
    if (!adapter) return undefined;
    return {
      workspaceId: entry.workspaceId,
      languageId: entry.presetLanguageId,
      adapter,
    };
  }

  private resetIdleTimer(workspaceId: string, languageId: string): void {
    let workspaceTimers = this.idleTimers.get(workspaceId);
    if (!workspaceTimers) {
      workspaceTimers = new Map<string, ReturnType<typeof setTimeout>>();
      this.idleTimers.set(workspaceId, workspaceTimers);
    }

    const existing = workspaceTimers.get(languageId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const handle = setTimeout(() => {
      this.shutdownAdapter(workspaceId, languageId);
    }, this.idleTimeoutMs);
    workspaceTimers.set(languageId, handle);
  }

  private clearIdleTimer(workspaceId: string, languageId: string): void {
    const workspaceTimers = this.idleTimers.get(workspaceId);
    if (!workspaceTimers) return;

    const handle = workspaceTimers.get(languageId);
    if (handle !== undefined) {
      clearTimeout(handle);
      workspaceTimers.delete(languageId);
    }

    if (workspaceTimers.size === 0) {
      this.idleTimers.delete(workspaceId);
    }
  }

  private shutdownAdapter(workspaceId: string, presetLanguageId: string): void {
    this.clearIdleTimer(workspaceId, presetLanguageId);
    const workspaceAdapters = this.adapters.get(workspaceId);
    const adapter = workspaceAdapters?.get(presetLanguageId);
    if (adapter) {
      workspaceAdapters?.delete(presetLanguageId);
      adapter.dispose();
    }

    if (workspaceAdapters?.size === 0) {
      this.adapters.delete(workspaceId);
    }

    this.removeUriIndexEntriesForAdapter(workspaceId, presetLanguageId);
  }

  private shutdownWorkspace(workspaceId: string): void {
    const workspaceAdapters = this.adapters.get(workspaceId);
    if (!workspaceAdapters) {
      this.removeUriIndexEntriesForWorkspace(workspaceId);
      return;
    }

    for (const [presetLanguageId, adapter] of workspaceAdapters) {
      this.clearIdleTimer(workspaceId, presetLanguageId);
      adapter.dispose();
    }
    this.adapters.delete(workspaceId);
    this.idleTimers.delete(workspaceId);
    this.removeUriIndexEntriesForWorkspace(workspaceId);
  }

  private removeUriIndexEntriesForAdapter(workspaceId: string, presetLanguageId: string): void {
    for (const [uri, entry] of this.uriIndex) {
      if (entry.workspaceId === workspaceId && entry.presetLanguageId === presetLanguageId) {
        this.uriIndex.delete(uri);
      }
    }
  }

  private removeUriIndexEntriesForWorkspace(workspaceId: string): void {
    for (const [uri, entry] of this.uriIndex) {
      if (entry.workspaceId === workspaceId) {
        this.uriIndex.delete(uri);
      }
    }
  }

  disposeAll(): void {
    for (const workspaceId of Array.from(this.adapters.keys())) {
      this.shutdownWorkspace(workspaceId);
    }
    for (const [workspaceId, workspaceTimers] of this.idleTimers) {
      for (const languageId of Array.from(workspaceTimers.keys())) {
        this.clearIdleTimer(workspaceId, languageId);
      }
    }
    this.idleTimers.clear();
    this.uriIndex.clear();
  }
}
