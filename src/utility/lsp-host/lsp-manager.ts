// LSP manager — composition root that wires the four LSP sub-systems together.
// Runs inside the lsp-host utility process; communicates with the main process
// via MessagePort set up by lspHost.ts in the main process.
//
// Lifecycle: lazy spawn on first didOpen, 30-minute idle graceful shutdown.

import type { Registration } from "../../shared/lsp";
import { AdapterRegistry, type LspAdapterFactory } from "./adapter-registry";
import { LspCallDispatcher } from "./lsp-call-dispatcher";
import type { LspManagerContext, RoutedAdapter } from "./lsp-handlers";
import { type IMessagePort, type InboundMsg, LspPortTransport } from "./lsp-port-transport";
import type { ServerHandlerContext } from "./lsp-server-request-handlers";
import type { LspAdapter } from "./servers/stdio-lsp-adapter";
import { WatchedFilesRouter } from "./watched-files-router";

export type { LspAdapterFactory };

export interface LspManagerOpts {
  /** Override the idle shutdown timeout. Defaults to LSP_DEFAULT_IDLE_MS; only set in tests. */
  idleTimeoutMs?: number;
  /** Override adapter construction. Intended for focused unit tests. */
  adapterFactory?: LspAdapterFactory;
}

// ---------------------------------------------------------------------------
// LspManager — composition root
// ---------------------------------------------------------------------------

export class LspManager implements LspManagerContext, ServerHandlerContext {
  // LspManagerContext — shared with handler catalog
  /** @internal */ adapters: Map<string, Map<string, LspAdapter>>;
  /** @internal */ uriIndex = new Map<string, { workspaceId: string; presetLanguageId: string }>();

  // ServerHandlerContext — shared with server-request handlers
  /** @internal */ configurationStore: Map<string, Map<string, Map<string, unknown>>>;
  /** @internal */ watchedFileRegistrations: Map<string, Map<string, Registration[]>>;

  private readonly transport: LspPortTransport;
  private readonly registry: AdapterRegistry;
  private readonly dispatcher: LspCallDispatcher;
  private readonly fsRouter: WatchedFilesRouter;

  constructor(opts: LspManagerOpts = {}) {
    this.transport = new LspPortTransport();

    this.registry = new AdapterRegistry({
      idleTimeoutMs: opts.idleTimeoutMs,
      adapterFactory: opts.adapterFactory,
    });

    // Expose registry maps through the LspManagerContext / ServerHandlerContext
    // interfaces so handler callbacks can read them directly.
    this.adapters = this.registry.adapters;
    this.configurationStore = this.registry.configurationStore;
    this.watchedFileRegistrations = this.registry.watchedFileRegistrations;

    // Wire the registry so it can call send() and requestMain() via this root.
    this.registry.onSend = (msg) => this.send(msg);
    this.registry.serverHandlerContext = this;

    // URI index maintenance: when the registry tears down an adapter or a
    // workspace, remove the corresponding URI index entries here.
    this.registry.onAdapterShutdown = (workspaceId, languageId) => {
      this.removeUriIndexEntriesWhere(
        (e) => e.workspaceId === workspaceId && e.presetLanguageId === languageId,
      );
    };
    this.registry.onWorkspaceShutdown = (workspaceId) => {
      this.removeUriIndexEntriesWhere((e) => e.workspaceId === workspaceId);
    };

    this.dispatcher = new LspCallDispatcher(this, (msg) => this.send(msg));
    this.fsRouter = new WatchedFilesRouter(this.registry);

    this.transport.onMessage = (msg: InboundMsg) => this.handleMessage(msg);
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  /**
   * Attach the cross-process MessagePort that carries inbound calls
   * from the main process and outbound responses / events back. Called
   * once during utility-process startup; the rest of the manager
   * surface is inert until the port is attached.
   */
  attachPort(port: IMessagePort): void {
    this.transport.attachPort(port);
  }

  /** @internal — used by LspPortTransport, dispatcher, and server-handler tests */
  send(msg: unknown): void {
    this.transport.send(msg);
  }

  /** @internal — ServerHandlerContext */
  requestMain(method: string, params: unknown): Promise<unknown> {
    return this.transport.requestMain(method, params);
  }

  // ---------------------------------------------------------------------------
  // LspManagerContext implementation (delegated to registry)
  // ---------------------------------------------------------------------------

  /** @internal */
  async getOrCreateAdapter(
    workspaceId: string,
    languageId: string,
    workspaceRoot: string,
  ): Promise<LspAdapter | null> {
    return this.registry.getOrCreateAdapter(workspaceId, languageId, workspaceRoot);
  }

  /** @internal */
  findAdapterForUri(uri: string): RoutedAdapter | undefined {
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
    this.registry.resetIdleTimer(workspaceId, languageId);
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  /**
   * Tear down everything: shut down all adapters via the registry, drop
   * the URI index, and reject any pending main-process requests so
   * their callers don't hang. Used during utility-process shutdown.
   */
  disposeAll(): void {
    this.registry.disposeAll();
    this.uriIndex.clear();
    this.transport.clearPending("LSP manager disposed");
  }

  // ---------------------------------------------------------------------------
  // Private message routing
  // ---------------------------------------------------------------------------

  private handleMessage(msg: InboundMsg): void {
    if (msg.type === "call") {
      this.dispatcher.handleCall(msg);
      return;
    }
    if (msg.type === "cancel") {
      this.dispatcher.cancel(msg.id);
      return;
    }
    if (msg.type === "notify") {
      this.handleNotification(msg).catch((err: unknown) => {
        console.warn("[lsp-manager] notification handler failed", err);
      });
    }
  }

  private async handleNotification(msg: { method: string; args: unknown }): Promise<void> {
    if (msg.method === "fsChanged") {
      this.fsRouter.handleFsChanged(msg.args);
    }
  }

  private removeUriIndexEntriesWhere(
    predicate: (entry: { workspaceId: string; presetLanguageId: string }) => boolean,
  ): void {
    for (const [uri, entry] of this.uriIndex) {
      if (predicate(entry)) {
        this.uriIndex.delete(uri);
      }
    }
  }
}
