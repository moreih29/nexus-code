// LSP manager — owns language server adapter instances per workspace/language.
// Runs inside the lsp-host utility process; communicates with the main process
// via MessagePort set up by lspHost.ts in the main process.
//
// Lifecycle: lazy spawn on first didOpen, 30-minute idle graceful shutdown.

import path from "node:path";
import { absolutePathToFileUri } from "../../shared/file-uri";
import { createKeyedDebouncer, type KeyedDebouncer } from "../../shared/keyed-debouncer";
import {
  type LspServerSpec,
  resolveLspPreset,
  resolveLspPresetLanguageId,
} from "../../shared/lsp-config";
import type { Registration } from "../../shared/lsp-types";
import { PendingRequestMap } from "../../shared/pending-request-map";
import { LSP_DEFAULT_IDLE_MS } from "../../shared/timing-constants";
import {
  FsChangedArgsSchema,
  fsChangeKindToLspType,
  type HandlerMeta,
  handlerMetadata,
  invokeLspHandler,
  type LspManagerContext,
  type MethodName,
  parseHandlerOutput,
  type RoutedAdapter,
} from "./lsp-handlers";
import { parsePublishDiagnostics } from "./lsp-result-normalizers";
import {
  flattenInitializationOptions,
  forwardServerEvent,
  handleClientRegisterCapability,
  handleShowMessageRequest,
  handleWorkDoneProgressCreate,
  handleWorkspaceApplyEdit,
  handleWorkspaceConfiguration,
  type ServerHandlerContext,
} from "./lsp-server-request-handlers";
import { type LspAdapter, StdioLspAdapter } from "./servers/stdio-lsp-adapter";

// ---------------------------------------------------------------------------
// Inbound message shapes (main → utility)
// ---------------------------------------------------------------------------

interface CallMsg {
  type: "call";
  id: string | number;
  method: string;
  args: unknown;
}

interface CancelMsg {
  type: "cancel";
  id: string | number;
}

interface NotifyMsg {
  type: "notify";
  method: string;
  args: unknown;
}

interface ServerResponseMsg {
  type: "serverResponse";
  id: string | number;
  result?: unknown;
  error?: unknown;
}

type InboundMsg = CallMsg | CancelMsg | NotifyMsg | ServerResponseMsg;

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

const MAIN_SERVER_REQUEST_TIMEOUT_MS = 10_000;

export interface LspManagerOpts {
  /** Override the idle shutdown timeout. Defaults to LSP_DEFAULT_IDLE_MS; only set in tests. */
  idleTimeoutMs?: number;
  /** Override adapter construction. Intended for focused unit tests. */
  adapterFactory?: LspAdapterFactory;
}

export type LspAdapterFactory = (
  spec: LspServerSpec,
  workspaceId: string,
  workspaceRootUri: string | null,
) => LspAdapter;

// ---------------------------------------------------------------------------
// LspManager
// ---------------------------------------------------------------------------

export class LspManager implements LspManagerContext, ServerHandlerContext {
  private port: IMessagePort | null = null;
  // keyed by workspaceId, then preset languageId
  /** @internal */ adapters = new Map<string, Map<string, LspAdapter>>();
  /** @internal */ uriIndex = new Map<string, UriIndexEntry>();
  /** @internal */ configurationStore = new Map<string, Map<string, Map<string, unknown>>>();
  /** @internal */ watchedFileRegistrations = new Map<string, Map<string, Registration[]>>();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly inFlightCalls = new Map<string | number, AbortController>();
  private readonly pendingMainRequests = new PendingRequestMap<string | number, unknown>();
  private nextMainRequestId = 1;
  private readonly idleTimeoutMs: number;
  private readonly adapterFactory: LspAdapterFactory;
  // keyed by composite "workspaceId\0languageId" — timer handle for idle shutdown
  private readonly idleTimers: KeyedDebouncer<string>;

  constructor(opts: LspManagerOpts = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? LSP_DEFAULT_IDLE_MS;
    this.adapterFactory =
      opts.adapterFactory ??
      ((spec, workspaceId, workspaceRootUri) =>
        new StdioLspAdapter(spec, workspaceId, workspaceRootUri));
    this.idleTimers = createKeyedDebouncer<string>({ delayMs: this.idleTimeoutMs });
  }

  attachPort(port: IMessagePort): void {
    this.port = port;
    port.on("message", (event) => {
      this.handleMessage(event.data as InboundMsg);
    });
    port.start();
  }

  /** @internal */
  send(msg: unknown): void {
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
      return;
    }

    if (msg.type === "cancel") {
      this.inFlightCalls.get(msg.id)?.abort();
      return;
    }

    if (msg.type === "notify") {
      this.handleNotification(msg).catch((err: unknown) => {
        console.warn("[lsp-manager] notification handler failed", err);
      });
      return;
    }

    if (msg.type === "serverResponse") {
      this.handleMainResponse(msg);
    }
  }

  private handleMainResponse(msg: ServerResponseMsg): void {
    if (msg.error) {
      this.pendingMainRequests.reject(msg.id, new Error(String(msg.error)));
    } else {
      this.pendingMainRequests.resolve(msg.id, msg.result ?? null);
    }
  }

  private async handleNotification(msg: NotifyMsg): Promise<void> {
    if (msg.method === "fsChanged") {
      this.handleFsChanged(msg.args);
    }
  }

  /** @internal */
  requestMain(method: string, params: unknown): Promise<unknown> {
    if (!this.port) {
      return Promise.reject(new Error("main port is not attached"));
    }

    const id = `server-${this.nextMainRequestId++}`;
    const promise = this.pendingMainRequests.register({
      key: id,
      timeoutMs: MAIN_SERVER_REQUEST_TIMEOUT_MS,
      onTimeout: () => new Error(`server request timed out: ${method}`),
    });
    this.send({ type: "serverRequest", id, method, params });
    return promise;
  }

  private async handleCall(msg: CallMsg): Promise<void> {
    const { id } = msg;
    const abortController = new AbortController();
    this.inFlightCalls.set(id, abortController);
    try {
      await this.dispatchCall(msg, abortController.signal);
    } finally {
      this.inFlightCalls.delete(id);
    }
  }

  private async dispatchCall(msg: CallMsg, signal: AbortSignal): Promise<void> {
    const { id, method } = msg;
    const meta = handlerMetadata[method as MethodName];
    if (!meta) {
      this.send({ type: "response", id, error: `unknown method: ${method}` });
      return;
    }
    const parsed = meta.inSchema.safeParse(msg.args);
    if (!parsed.success) {
      this.send({ type: "response", id, error: parsed.error.message });
      return;
    }

    const routed = await meta.route(this, parsed.data);
    if (!routed) {
      const result = meta.outSchema.parse(meta.emptyResponse);
      this.send({ type: "response", id, result: result ?? null });
      return;
    }

    if (Array.isArray(routed)) {
      await this.dispatchFanOutCall(id, meta, parsed.data, routed, signal);
      return;
    }

    if (meta.capabilityKey && !routed.adapter.hasCapability(meta.capabilityKey)) {
      const result = meta.outSchema.parse(meta.emptyResponse);
      this.send({ type: "response", id, result: result ?? null });
      return;
    }

    this.resetIdleTimer(routed.workspaceId, routed.languageId);
    const result = parseHandlerOutput(
      meta,
      await invokeLspHandler(meta, routed.adapter, parsed.data, signal),
    );
    meta.after?.(this, parsed.data, routed);
    this.send({ type: "response", id, result: result ?? null });
  }

  private async dispatchFanOutCall(
    id: string | number,
    meta: HandlerMeta,
    args: unknown,
    routedAdapters: RoutedAdapter[],
    signal: AbortSignal,
  ): Promise<void> {
    if (routedAdapters.length === 0) {
      const result = meta.outSchema.parse(meta.emptyResponse);
      this.send({ type: "response", id, result: result ?? null });
      return;
    }

    for (const routed of routedAdapters) {
      this.resetIdleTimer(routed.workspaceId, routed.languageId);
    }

    const supportedAdapters = routedAdapters.filter(
      (routed) => !meta.capabilityKey || routed.adapter.hasCapability(meta.capabilityKey),
    );
    if (supportedAdapters.length === 0) {
      const result = meta.outSchema.parse(meta.emptyResponse);
      this.send({ type: "response", id, result: result ?? null });
      return;
    }

    const settled = await Promise.allSettled(
      supportedAdapters.map(async (routed) =>
        parseHandlerOutput(meta, await invokeLspHandler(meta, routed.adapter, args, signal)),
      ),
    );

    const merged: unknown[] = [];
    for (const item of settled) {
      if (item.status === "fulfilled") {
        if (Array.isArray(item.value)) {
          merged.push(...item.value);
        } else {
          merged.push(item.value);
        }
      } else {
        console.warn(`[lsp-manager] ${meta.lspMethod} fan-out request failed`, item.reason);
      }
    }

    const result = meta.outSchema.parse(merged);
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
      this.workspaceRoots.set(workspaceId, workspaceRoot);
      this.storeInitializationOptions(workspaceId, presetLanguageId, preset.initializationOptions);
      adapter = this.adapterFactory(preset, workspaceId, absolutePathToFileUri(workspaceRoot));
      this.registerServerHandlers(adapter, workspaceId, presetLanguageId);
      await adapter.start();
      workspaceAdapters.set(presetLanguageId, adapter);
    }
    return adapter;
  }

  private registerServerHandlers(
    adapter: LspAdapter,
    workspaceId: string,
    presetLanguageId: string,
  ): void {
    adapter.onServerNotification("textDocument/publishDiagnostics", (params) => {
      const parsed = parsePublishDiagnostics(params);
      if (parsed) {
        this.send({
          type: "diagnostics",
          uri: parsed.uri,
          diagnostics: parsed.diagnostics,
        });
      }
    });
    adapter.onServerNotification("window/logMessage", (params) => {
      forwardServerEvent(this, workspaceId, presetLanguageId, "window/logMessage", params);
    });
    adapter.onServerNotification("window/showMessage", (params) => {
      forwardServerEvent(this, workspaceId, presetLanguageId, "window/showMessage", params);
    });
    adapter.onServerNotification("$/progress", (params) => {
      forwardServerEvent(this, workspaceId, presetLanguageId, "$/progress", params);
    });

    adapter.onServerRequest("workspace/configuration", (params) =>
      handleWorkspaceConfiguration(this, workspaceId, presetLanguageId, params),
    );
    adapter.onServerRequest("client/registerCapability", (params) =>
      handleClientRegisterCapability(this, workspaceId, presetLanguageId, params),
    );
    adapter.onServerRequest("workspace/applyEdit", (params) =>
      handleWorkspaceApplyEdit(this, params),
    );
    adapter.onServerRequest("window/showMessageRequest", (params) =>
      handleShowMessageRequest(this, workspaceId, presetLanguageId, params),
    );
    adapter.onServerRequest("window/workDoneProgress/create", (params) =>
      handleWorkDoneProgressCreate(this, workspaceId, presetLanguageId, params),
    );
  }

  private storeInitializationOptions(
    workspaceId: string,
    presetLanguageId: string,
    initializationOptions: unknown,
  ): void {
    let workspaceConfig = this.configurationStore.get(workspaceId);
    if (!workspaceConfig) {
      workspaceConfig = new Map<string, Map<string, unknown>>();
      this.configurationStore.set(workspaceId, workspaceConfig);
    }
    workspaceConfig.set(presetLanguageId, flattenInitializationOptions(initializationOptions));
  }

  private handleFsChanged(params: unknown): void {
    const parsed = FsChangedArgsSchema.safeParse(params);
    if (!parsed.success) return;

    const workspaceAdapters = this.adapters.get(parsed.data.workspaceId);
    const workspaceRegistrations = this.watchedFileRegistrations.get(parsed.data.workspaceId);
    const workspaceRoot = this.workspaceRoots.get(parsed.data.workspaceId);
    if (!workspaceAdapters || !workspaceRegistrations || !workspaceRoot) return;

    const changes = parsed.data.changes.map((change) => ({
      uri: absolutePathToFileUri(path.join(workspaceRoot, change.relPath)),
      type: fsChangeKindToLspType(change.kind),
    }));
    if (changes.length === 0) return;

    for (const [presetLanguageId, adapter] of workspaceAdapters) {
      const registrations = workspaceRegistrations.get(presetLanguageId);
      if (!registrations || registrations.length === 0) continue;

      adapter.notify("workspace/didChangeWatchedFiles", { changes });
      this.resetIdleTimer(parsed.data.workspaceId, presetLanguageId);
    }
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
    this.idleTimers.schedule(`${workspaceId}\0${languageId}`, () => {
      this.shutdownAdapter(workspaceId, languageId);
    });
  }

  private clearIdleTimer(workspaceId: string, languageId: string): void {
    this.idleTimers.cancel(`${workspaceId}\0${languageId}`);
  }

  private shutdownAdapter(workspaceId: string, presetLanguageId: string): void {
    this.clearIdleTimer(workspaceId, presetLanguageId);
    const workspaceAdapters = this.adapters.get(workspaceId);
    const adapter = workspaceAdapters?.get(presetLanguageId);
    if (adapter) {
      workspaceAdapters?.delete(presetLanguageId);
      adapter.dispose();
    }
    this.configurationStore.get(workspaceId)?.delete(presetLanguageId);
    this.watchedFileRegistrations.get(workspaceId)?.delete(presetLanguageId);

    if (workspaceAdapters?.size === 0) {
      this.adapters.delete(workspaceId);
      this.configurationStore.delete(workspaceId);
      this.watchedFileRegistrations.delete(workspaceId);
      this.workspaceRoots.delete(workspaceId);
    }

    this.removeUriIndexEntriesForAdapter(workspaceId, presetLanguageId);
  }

  private shutdownWorkspace(workspaceId: string): void {
    const workspaceAdapters = this.adapters.get(workspaceId);
    if (!workspaceAdapters) {
      this.configurationStore.delete(workspaceId);
      this.watchedFileRegistrations.delete(workspaceId);
      this.workspaceRoots.delete(workspaceId);
      this.removeUriIndexEntriesForWorkspace(workspaceId);
      return;
    }

    for (const [presetLanguageId, adapter] of workspaceAdapters) {
      this.clearIdleTimer(workspaceId, presetLanguageId);
      adapter.dispose();
    }
    this.adapters.delete(workspaceId);
    this.configurationStore.delete(workspaceId);
    this.watchedFileRegistrations.delete(workspaceId);
    this.workspaceRoots.delete(workspaceId);
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
    this.idleTimers.clearAll();
    this.uriIndex.clear();
    this.configurationStore.clear();
    this.watchedFileRegistrations.clear();
    this.workspaceRoots.clear();
    this.pendingMainRequests.clearAll("LSP manager disposed");
  }
}
