/**
 * Adapter registry — lifecycle management for `(workspaceId, languageId)` → adapter pairs.
 *
 * Owns the canonical adapter map, the workspace-root map, the configuration
 * store, and the watched-file registration map.  Handles lazy creation,
 * idle-timer–driven shutdown, and workspace-wide teardown.  Server-handler
 * wiring is performed here at creation time so that every adapter is fully
 * configured before its first use.
 */

import { absolutePathToFileUri } from "../../shared/file-uri";
import { createKeyedDebouncer, type KeyedDebouncer } from "../../shared/keyed-debouncer";
import { type LspServerSpec, resolveLspPreset, resolveLspPresetLanguageId } from "../../shared/lsp-config";
import type { Registration } from "../../shared/lsp";
import { LSP_DEFAULT_IDLE_MS } from "../../shared/timing-constants";
import { flattenInitializationOptions } from "./lsp-server-request-handlers";
import type { ServerHandlerContext } from "./lsp-server-request-handlers";
import {
  forwardServerEvent,
  handleClientRegisterCapability,
  handleShowMessageRequest,
  handleWorkDoneProgressCreate,
  handleWorkspaceApplyEdit,
  handleWorkspaceConfiguration,
} from "./lsp-server-request-handlers";
import { parsePublishDiagnostics } from "./lsp-result-normalizers";
import { type LspAdapter, StdioLspAdapter } from "./servers/stdio-lsp-adapter";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LspAdapterFactory = (
  spec: LspServerSpec,
  workspaceId: string,
  workspaceRootUri: string | null,
) => LspAdapter;

export interface AdapterRegistryOpts {
  /** Override the idle shutdown timeout. Defaults to LSP_DEFAULT_IDLE_MS; only set in tests. */
  idleTimeoutMs?: number;
  /** Override adapter construction. Intended for focused unit tests. */
  adapterFactory?: LspAdapterFactory;
}

// ---------------------------------------------------------------------------
// AdapterRegistry
// ---------------------------------------------------------------------------

export class AdapterRegistry {
  /** keyed by workspaceId → presetLanguageId → adapter */
  readonly adapters = new Map<string, Map<string, LspAdapter>>();
  /** configurationStore: workspaceId → presetLanguageId → flat key → value */
  readonly configurationStore = new Map<string, Map<string, Map<string, unknown>>>();
  /** watchedFileRegistrations: workspaceId → presetLanguageId → registrations */
  readonly watchedFileRegistrations = new Map<string, Map<string, Registration[]>>();
  /** workspaceRoots: workspaceId → absolute root path */
  readonly workspaceRoots = new Map<string, string>();

  private readonly idleTimeoutMs: number;
  private readonly adapterFactory: LspAdapterFactory;
  private readonly idleTimers: KeyedDebouncer<string>;

  /**
   * Callback invoked when `send` needs to be called outside of server-handler
   * context (e.g. diagnostics push).  Injected by LspManager after construction.
   */
  onSend: ((msg: unknown) => void) | null = null;

  /**
   * Context passed to server-handler callbacks.  Set by LspManager to itself
   * so that handlers can call `send` and `requestMain`.
   */
  serverHandlerContext: ServerHandlerContext | null = null;

  constructor(opts: AdapterRegistryOpts = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? LSP_DEFAULT_IDLE_MS;
    this.adapterFactory =
      opts.adapterFactory ??
      ((spec, workspaceId, workspaceRootUri) =>
        new StdioLspAdapter(spec, workspaceId, workspaceRootUri));
    this.idleTimers = createKeyedDebouncer<string>({ delayMs: this.idleTimeoutMs });
  }

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

  shutdownAdapter(workspaceId: string, presetLanguageId: string): void {
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

    this.onAdapterShutdown?.(workspaceId, presetLanguageId);
  }

  shutdownWorkspace(workspaceId: string): void {
    const workspaceAdapters = this.adapters.get(workspaceId);
    if (!workspaceAdapters) {
      this.configurationStore.delete(workspaceId);
      this.watchedFileRegistrations.delete(workspaceId);
      this.workspaceRoots.delete(workspaceId);
      this.onWorkspaceShutdown?.(workspaceId);
      return;
    }

    for (const [presetLanguageId] of workspaceAdapters) {
      this.clearIdleTimer(workspaceId, presetLanguageId);
    }
    for (const [, adapter] of workspaceAdapters) {
      adapter.dispose();
    }
    this.adapters.delete(workspaceId);
    this.configurationStore.delete(workspaceId);
    this.watchedFileRegistrations.delete(workspaceId);
    this.workspaceRoots.delete(workspaceId);
    this.onWorkspaceShutdown?.(workspaceId);
  }

  resetIdleTimer(workspaceId: string, languageId: string): void {
    this.idleTimers.schedule(`${workspaceId}\0${languageId}`, () => {
      this.shutdownAdapter(workspaceId, languageId);
    });
  }

  disposeAll(): void {
    this.idleTimers.clearAll();
    for (const workspaceId of Array.from(this.adapters.keys())) {
      const workspaceAdapters = this.adapters.get(workspaceId);
      if (workspaceAdapters) {
        for (const [, adapter] of workspaceAdapters) {
          adapter.dispose();
        }
      }
    }
    this.adapters.clear();
    this.configurationStore.clear();
    this.watchedFileRegistrations.clear();
    this.workspaceRoots.clear();
  }

  /**
   * Called by LspManager when an adapter is shut down (idle or dispose), so
   * the URI index can be cleaned up.
   */
  onAdapterShutdown: ((workspaceId: string, languageId: string) => void) | null = null;

  /**
   * Called by LspManager when an entire workspace is shut down, so the URI
   * index can be cleaned up.
   */
  onWorkspaceShutdown: ((workspaceId: string) => void) | null = null;

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private registerServerHandlers(
    adapter: LspAdapter,
    workspaceId: string,
    presetLanguageId: string,
  ): void {
    adapter.onServerNotification("textDocument/publishDiagnostics", (params) => {
      const parsed = parsePublishDiagnostics(params);
      if (parsed && this.onSend) {
        this.onSend({
          type: "diagnostics",
          uri: parsed.uri,
          diagnostics: parsed.diagnostics,
        });
      }
    });
    adapter.onServerNotification("window/logMessage", (params) => {
      if (this.serverHandlerContext) {
        forwardServerEvent(this.serverHandlerContext, workspaceId, presetLanguageId, "window/logMessage", params);
      }
    });
    adapter.onServerNotification("window/showMessage", (params) => {
      if (this.serverHandlerContext) {
        forwardServerEvent(this.serverHandlerContext, workspaceId, presetLanguageId, "window/showMessage", params);
      }
    });
    adapter.onServerNotification("$/progress", (params) => {
      if (this.serverHandlerContext) {
        forwardServerEvent(this.serverHandlerContext, workspaceId, presetLanguageId, "$/progress", params);
      }
    });

    adapter.onServerRequest("workspace/configuration", (params) => {
      if (!this.serverHandlerContext) return [];
      return handleWorkspaceConfiguration(this.serverHandlerContext, workspaceId, presetLanguageId, params);
    });
    adapter.onServerRequest("client/registerCapability", (params) => {
      if (!this.serverHandlerContext) return null;
      return handleClientRegisterCapability(this.serverHandlerContext, workspaceId, presetLanguageId, params);
    });
    adapter.onServerRequest("workspace/applyEdit", (params) => {
      if (!this.serverHandlerContext) return { applied: false, failureReason: "not ready" };
      return handleWorkspaceApplyEdit(this.serverHandlerContext, params);
    });
    adapter.onServerRequest("window/showMessageRequest", (params) => {
      if (!this.serverHandlerContext) return null;
      return handleShowMessageRequest(this.serverHandlerContext, workspaceId, presetLanguageId, params);
    });
    adapter.onServerRequest("window/workDoneProgress/create", (params) => {
      if (!this.serverHandlerContext) return null;
      return handleWorkDoneProgressCreate(this.serverHandlerContext, workspaceId, presetLanguageId, params);
    });
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

  private clearIdleTimer(workspaceId: string, languageId: string): void {
    this.idleTimers.cancel(`${workspaceId}\0${languageId}`);
  }
}
