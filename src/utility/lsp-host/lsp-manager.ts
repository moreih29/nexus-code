// LSP manager — owns language server adapter instances per workspace/language.
// Runs inside the lsp-host utility process; communicates with the main process
// via MessagePort set up by lspHost.ts in the main process.
//
// Lifecycle: lazy spawn on first didOpen, 30-minute idle graceful shutdown.

import { z } from "zod";
import { absolutePathToFileUri } from "../../shared/file-uri";
import { resolveLspPreset, resolveLspPresetLanguageId } from "../../shared/lsp-config";
import { LSP_DEFAULT_IDLE_MS } from "../../shared/timing-constants";
import { type LspAdapter, StdioLspAdapter } from "./servers/stdio-lsp-adapter";

// Inbound message shapes (main → utility)
interface CallMsg {
  type: "call";
  id: string | number;
  method: string;
  args: unknown;
}

type InboundMsg = CallMsg;

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

export interface LspManagerOpts {
  /** Override the idle shutdown timeout. Defaults to LSP_DEFAULT_IDLE_MS; only set in tests. */
  idleTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Argument schemas — mirrors ipc-contract.lsp.call shapes, but without
// UUID-strictness so the utility process does not depend on renderer-level
// validation constraints.
// ---------------------------------------------------------------------------

const argSchemas = {
  didOpen: z.object({
    workspaceId: z.string(),
    workspaceRoot: z.string(),
    uri: z.string(),
    languageId: z.string(),
    version: z.number().int(),
    text: z.string(),
  }),
  didChange: z.object({
    uri: z.string(),
    version: z.number().int(),
    text: z.string(),
  }),
  didClose: z.object({ uri: z.string() }),
  hover: z.object({
    uri: z.string(),
    line: z.number().int(),
    character: z.number().int(),
  }),
  definition: z.object({
    uri: z.string(),
    line: z.number().int(),
    character: z.number().int(),
  }),
  completion: z.object({
    uri: z.string(),
    line: z.number().int(),
    character: z.number().int(),
  }),
} as const;

type ArgSchemas = typeof argSchemas;
type MethodName = keyof ArgSchemas;
type ArgsFor<K extends MethodName> = z.infer<ArgSchemas[K]>;

// ---------------------------------------------------------------------------
// Handler table
// ---------------------------------------------------------------------------

interface HandlerCtx {
  manager: LspManager;
}

type Handler<K extends MethodName> = (ctx: HandlerCtx, args: ArgsFor<K>) => Promise<unknown>;

type RequestHandlers = { [K in MethodName]: Handler<K> };

const requestHandlers: RequestHandlers = {
  async didOpen(
    { manager },
    { workspaceId, workspaceRoot, uri, languageId, version, text },
  ) {
    const presetLanguageId = resolveLspPresetLanguageId(languageId);
    const adapter = presetLanguageId
      ? await manager.getOrCreateAdapter(workspaceId, languageId, workspaceRoot)
      : null;
    if (adapter && presetLanguageId) {
      manager.resetIdleTimer(workspaceId, presetLanguageId);
      await adapter.didOpen(uri, languageId, version, text);
      manager.uriIndex.set(uri, { workspaceId, presetLanguageId });
    }
    return null;
  },

  async didChange({ manager }, { uri, version, text }) {
    const routed = manager.findAdapterForUri(uri);
    if (routed) {
      manager.resetIdleTimer(routed.workspaceId, routed.languageId);
      await routed.adapter.didChange(uri, version, text);
    }
    return null;
  },

  async didClose({ manager }, { uri }) {
    const routed = manager.findAdapterForUri(uri);
    if (routed) {
      manager.resetIdleTimer(routed.workspaceId, routed.languageId);
      await routed.adapter.didClose(uri);
    }
    manager.uriIndex.delete(uri);
    return null;
  },

  async hover({ manager }, { uri, line, character }) {
    const routed = manager.findAdapterForUri(uri);
    if (!routed) return null;
    manager.resetIdleTimer(routed.workspaceId, routed.languageId);
    return routed.adapter.hover(uri, line, character);
  },

  async definition({ manager }, { uri, line, character }) {
    const routed = manager.findAdapterForUri(uri);
    if (!routed) return [];
    manager.resetIdleTimer(routed.workspaceId, routed.languageId);
    return routed.adapter.definition(uri, line, character);
  },

  async completion({ manager }, { uri, line, character }) {
    const routed = manager.findAdapterForUri(uri);
    if (!routed) return [];
    manager.resetIdleTimer(routed.workspaceId, routed.languageId);
    return routed.adapter.completion(uri, line, character);
  },
};

// ---------------------------------------------------------------------------
// LspManager
// ---------------------------------------------------------------------------

export class LspManager {
  private port: IMessagePort | null = null;
  // keyed by workspaceId, then preset languageId
  /** @internal */ adapters = new Map<string, Map<string, LspAdapter>>();
  // keyed by workspaceId, then preset languageId — timer handle for idle shutdown
  private idleTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  /** @internal */ uriIndex = new Map<string, UriIndexEntry>();
  private readonly idleTimeoutMs: number;

  constructor(opts: LspManagerOpts = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? LSP_DEFAULT_IDLE_MS;
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
    const { id, method } = msg;
    const handler = requestHandlers[method as MethodName];
    if (!handler) {
      this.send({ type: "response", id, error: `unknown method: ${method}` });
      return;
    }
    const schema = argSchemas[method as MethodName];
    const parsed = schema.safeParse(msg.args);
    if (!parsed.success) {
      this.send({ type: "response", id, error: parsed.error.message });
      return;
    }
    const result = await (handler as Handler<MethodName>)(
      { manager: this },
      parsed.data as ArgsFor<MethodName>,
    );
    this.send({ type: "response", id, result: result ?? null });
  }

  /** @internal */
  async getOrCreateAdapter(
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

  /** @internal */
  findAdapterForUri(uri: string):
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

  /** @internal */
  resetIdleTimer(workspaceId: string, languageId: string): void {
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
