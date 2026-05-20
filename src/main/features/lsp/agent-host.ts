import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AgentManifestSchema, findLspBinary } from "../../../shared/agent/manifest";
import {
  ApplyWorkspaceEditParamsSchema,
  CANONICAL_TOKEN_TYPES,
  CompletionItemSchema,
  ConfigurationParamsSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  HoverResultSchema,
  LocationSchema,
  LSP_CLIENT_CAPABILITIES,
  type LspServerEventMethod,
  ReferencesArgsSchema,
  remapSemanticTokenData,
  SemanticTokensArgsSchema,
  SemanticTokensResultSchema,
  SymbolInformationSchema,
  TextDocumentContentChangeEventSchema,
  TextDocumentIdentifierSchema,
  TextDocumentItemSchema,
  TextDocumentPositionArgsSchema,
} from "../../../shared/lsp";
import {
  type LspServerSpec,
  resolveLspPreset,
  resolveLspPresetLanguageId,
} from "../../../shared/lsp/config";
import {
  LSP_COMPLETION_TIMEOUT_MS,
  LSP_CONSECUTIVE_TIMEOUT_LIMIT,
  LSP_DEFAULT_IDLE_MS,
  LSP_DEFINITION_TIMEOUT_MS,
  LSP_DOCUMENT_HIGHLIGHT_TIMEOUT_MS,
  LSP_DOCUMENT_SYMBOL_TIMEOUT_MS,
  LSP_HOVER_TIMEOUT_MS,
  LSP_MAX_ACTIVE_WORKSPACES,
  LSP_REFERENCES_TIMEOUT_MS,
  LSP_SEMANTIC_TOKENS_TIMEOUT_MS,
  LSP_SERVER_WEDGE_GRACE_MS,
  LSP_WORKSPACE_SYMBOL_TIMEOUT_MS,
} from "../../../shared/util/timing-constants";
import type { AgentChannel } from "../../infra/agent/channel";
import {
  LOCAL_AGENT_DIST_DIR,
  LSP_BOOTSTRAP_PROGRESS_EVENT,
  type LspBootstrapProgressEvent,
} from "../../infra/agent/ssh/ssh-bootstrap/index";
import { AgentLspServer } from "./agent-lsp-server";
import { flattenInitializationOptions, lookupFlattenedConfig } from "./config-store";
import { DiagnosticsDebouncer } from "./diagnostics-debouncer";
import type { LspHostCallOptions, LspHostHandle } from "./host";
import {
  firstShowMessageAction,
  parseAgentMessagePayload,
  parseAgentServerRequestPayload,
  parseServerAssignedPayload,
  parseServerCapabilities,
  parseServerExitedPayload,
  parseSpawnResult,
  parseWorkDoneProgressCreateParams,
  serverExitError,
} from "./payloads";
import {
  normalizeCompletionResult,
  normalizeDefinitionResult,
  normalizeDocumentHighlightResult,
  normalizeDocumentSymbolResult,
  normalizeHoverResult,
  normalizeWorkspaceSymbolResult,
  parsePublishDiagnostics,
} from "./result-normalizers";
import { asRecord } from "./utils";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type EventCallback = (args: unknown) => void;

interface PendingServerRequest {
  channel: AgentChannel;
  serverId: string;
  agentRequestId: string;
}

interface PendingSpawn {
  channel: AgentChannel;
  workspaceId: string;
  languageId: string;
  correlationId: string;
}

interface ServerContext {
  workspaceId: string;
  languageId: string;
}

interface AgentSpawnResult {
  serverId: string;
  capabilities?: unknown;
}

const DIAGNOSTICS_DEBOUNCE_MS = 100;
const DIAGNOSTICS_LEADING_IDLE_MS = 500;

export interface AgentLspWorkspaceManager {
  getAgentChannel(workspaceId: string): Promise<AgentChannel>;
  ensureRemoteLspServer?(
    workspaceId: string,
    request: {
      readonly binaryName: string;
      readonly languageId: string;
      readonly args: readonly string[];
    },
    onProgress?: (event: LspBootstrapProgressEvent) => void,
  ): Promise<{ readonly binaryPath: string; readonly args: readonly string[] } | null>;
}

// ---------------------------------------------------------------------------
// Per-method argument schemas (close to the host class so the call() switch
// stays self-contained).
// ---------------------------------------------------------------------------

const DidOpenArgsSchema = TextDocumentItemSchema.extend({
  workspaceId: z.string(),
  workspaceRoot: z.string(),
});

// Every URI-scoped IPC call from the renderer carries workspaceId so the
// host can route to the right LSP server even when two workspaces open
// the same physical file (e.g. parent + nested-child workspace
// registrations sharing a frontend/src/main.tsx). The renderer derives
// workspaceId from the model's cacheUri (workspace-uri.ts) — uri itself
// stays in `file://` form because that is what the LSP server expects.
const WorkspaceScopedUriArgsSchema = z.object({
  workspaceId: z.string(),
  uri: TextDocumentIdentifierSchema.shape.uri,
});

const DidChangeArgsSchema = WorkspaceScopedUriArgsSchema.extend({
  version: TextDocumentItemSchema.shape.version,
  contentChanges: z.array(TextDocumentContentChangeEventSchema),
});

const DidSaveArgsSchema = WorkspaceScopedUriArgsSchema.extend({
  text: TextDocumentItemSchema.shape.text.optional(),
});

const DidCloseArgsSchema = WorkspaceScopedUriArgsSchema;

const WorkspaceSymbolArgsSchema = z.object({
  workspaceId: z.string(),
  query: z.string(),
});

const SERVER_EVENT_METHODS = new Set<string>([
  "window/logMessage",
  "window/showMessage",
  "window/showMessageRequest",
  "window/workDoneProgress/create",
  "$/progress",
]);

// ---------------------------------------------------------------------------
// Per-method request timeout table
//
// All keyed by the public method name used by call(). didOpen / didChange /
// didSave / didClose are notifications and intentionally absent — their
// resolution does not block any UI.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS: Record<string, number> = {
  hover: LSP_HOVER_TIMEOUT_MS,
  definition: LSP_DEFINITION_TIMEOUT_MS,
  completion: LSP_COMPLETION_TIMEOUT_MS,
  references: LSP_REFERENCES_TIMEOUT_MS,
  documentHighlight: LSP_DOCUMENT_HIGHLIGHT_TIMEOUT_MS,
  documentSymbol: LSP_DOCUMENT_SYMBOL_TIMEOUT_MS,
  workspaceSymbol: LSP_WORKSPACE_SYMBOL_TIMEOUT_MS,
  semanticTokens: LSP_SEMANTIC_TOKENS_TIMEOUT_MS,
};

/**
 * Sentinel error class identifying a request that exceeded its bounded
 * wall-clock window. The IPC layer recognises it and returns the
 * method-appropriate empty value instead of propagating the rejection,
 * so the renderer's hover/completion widget closes cleanly rather than
 * staying in "Loading…" forever.
 */
export class LspRequestTimeoutError extends Error {
  readonly kind = "lsp-request-timeout";
  constructor(method: string, timeoutMs: number) {
    super(`LSP request ${method} timed out after ${timeoutMs}ms`);
    this.name = "LspRequestTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface AgentLspHostOptions {
  /** Override the LRU cap. Tests bump this to disable eviction. */
  maxActiveWorkspaces?: number;
  /**
   * Gate called before spawning a new LSP server for (workspaceId, languageId).
   * Return false to suppress spawn (language not enabled for this workspace).
   * Defaults to `() => true` so callers without per-language access control
   * (tests, existing usages) continue to work unchanged.
   */
  isLanguageEnabled?: (workspaceId: string, languageId: string) => boolean;
}

export function startAgentLspHost(
  workspaceManager: AgentLspWorkspaceManager,
  options: AgentLspHostOptions = {},
): LspHostHandle {
  return new AgentLspHostHandleImpl(workspaceManager, options);
}

class AgentLspHostHandleImpl implements LspHostHandle {
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly workspaceServers = new Map<string, Map<string, AgentLspServer>>();
  private readonly serversById = new Map<string, AgentLspServer>();
  private readonly serverPromises = new Map<string, Promise<AgentLspServer | null>>();
  // uriIndex: workspace → uri → presetLanguageId.
  //
  // Two workspaces can both open the same physical `file://` URI (e.g. a
  // parent workspace and a nested workspace registered separately by the
  // user). Routing by uri alone collides — whichever workspace registered
  // the URI last wins, and hover/completion/etc. for the other workspace
  // hangs because the renderer's request targets a server that no longer
  // owns the entry. Nesting by workspaceId keeps the two entries
  // independent so each workspace's LSP server handles its own copy of
  // the document.
  private readonly uriIndex = new Map<string, Map<string, string>>();
  private readonly configurationStore = new Map<string, Map<string, Map<string, unknown>>>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly channelDisposers = new Map<AgentChannel, Array<() => void>>();
  // correlationId is assigned client-side before lsp.spawn so the agent can
  // echo it back via the lsp.serverAssigned event before initialize finishes.
  // Both maps are populated up front and dropped once the spawn round-trip
  // completes (or fails).
  private readonly pendingSpawnByCorrelation = new Map<string, PendingSpawn>();
  private readonly pendingSpawnByServerId = new Map<string, PendingSpawn>();
  // Per-(workspace, URI) state for textDocument/publishDiagnostics debouncing.
  private readonly diagnosticsDebouncer = new DiagnosticsDebouncer({
    debounceMs: DIAGNOSTICS_DEBOUNCE_MS,
    leadingIdleMs: DIAGNOSTICS_LEADING_IDLE_MS,
    emit: (payload) => this.emit("diagnostics", payload),
  });
  /**
   * Wall-clock timestamp of the last activity (any call/notify that
   * resolved to a real server) for each workspace. Drives the LRU
   * eviction policy in `evictLruWorkspaceIfNeeded`. We use `Date.now`
   * directly rather than a monotonic counter so timestamps survive
   * across reconnects when callers compare on resume.
   */
  private readonly workspaceLastActivity = new Map<string, number>();
  /**
   * Number of consecutive request timeouts per (workspaceId, languageId)
   * server. Key = `${workspaceId}\0${languageId}`. Incremented by
   * `trackTimeout`, cleared by `resetTimeoutCount` on a successful
   * response, and wiped entirely when the server is disposed. When the
   * count reaches LSP_CONSECUTIVE_TIMEOUT_LIMIT the server is wedge-
   * restarted via `disposeWorkspaceServers`.
   */
  private readonly serverTimeoutCount = new Map<string, number>();
  /**
   * Wall-clock timestamp recorded in `rememberServer` for each
   * (workspaceId, languageId) server. Key = `${workspaceId}\0${languageId}`.
   * Used by `trackTimeout` to enforce the LSP_SERVER_WEDGE_GRACE_MS
   * window during which timeout counts are not incremented — some
   * servers (tsserver, basedpyright) are slow to initialize and would
   * otherwise be wedge-restarted immediately.
   */
  private readonly serverSpawnedAt = new Map<string, number>();
  /**
   * Soft cap on the number of workspaces with live LSP servers. When the
   * (N+1)-th workspace's first didOpen would push us over the cap, the
   * LRU workspace is disposed first. See LSP_MAX_ACTIVE_WORKSPACES for
   * the rationale and tuning.
   */
  private readonly maxActiveWorkspaces: number;
  /**
   * Optional predicate gate injected at construction time. Checked in
   * `getOrCreateServer` before any spawn is attempted. Returning false
   * suppresses spawn and returns null — the renderer entry stays dark.
   * Defaults to always-true so callers without per-language control
   * (tests, plain `startAgentLspHost()`) are unaffected.
   */
  private readonly isLanguageEnabled: (workspaceId: string, languageId: string) => boolean;
  private nextServerRequestId = 1;
  private disposed = false;

  /**
   * Fire-and-forget document notifications — they carry no observable result,
   * so a disposed host resolves them quietly instead of throwing (see call()).
   */
  private static readonly NOTIFICATION_METHODS = new Set([
    "didOpen",
    "didChange",
    "didSave",
    "didClose",
  ]);

  constructor(
    private readonly workspaceManager: AgentLspWorkspaceManager,
    options: AgentLspHostOptions = {},
  ) {
    this.maxActiveWorkspaces = options.maxActiveWorkspaces ?? LSP_MAX_ACTIVE_WORKSPACES;
    this.isLanguageEnabled = options.isLanguageEnabled ?? (() => true);
  }

  async call(method: string, args: unknown, opts: LspHostCallOptions = {}): Promise<unknown> {
    if (this.disposed) {
      // Document notifications can arrive after dispose() during app shutdown:
      // the LSP host is torn down on `before-quit` while the renderer is still
      // alive and emitting didClose as its editor models close. The host being
      // gone is the correct end state, so these resolve quietly — only
      // request-style methods (whose callers expect a result) still surface
      // the disposed error.
      if (AgentLspHostHandleImpl.NOTIFICATION_METHODS.has(method)) {
        return null;
      }
      throw new Error("LSP host disposed");
    }

    switch (method) {
      case "didOpen":
        return this.didOpen(args);
      case "didChange":
        return this.didChange(args);
      case "didSave":
        return this.didSave(args);
      case "didClose":
        return this.didClose(args);
      case "hover":
        return this.requestByUri(
          args,
          opts,
          {
            argsSchema: TextDocumentPositionArgsSchema,
            lspMethod: "textDocument/hover",
            capabilityKey: "hoverProvider",
            emptyResponse: null,
            outSchema: HoverResultSchema.nullable(),
            params: textDocumentPositionParams,
            transform: normalizeHoverResult,
          },
          "hover",
        );
      case "definition":
        return this.requestByUri(
          args,
          opts,
          {
            argsSchema: TextDocumentPositionArgsSchema,
            lspMethod: "textDocument/definition",
            capabilityKey: "definitionProvider",
            emptyResponse: [],
            outSchema: z.array(LocationSchema),
            params: textDocumentPositionParams,
            transform: normalizeDefinitionResult,
          },
          "definition",
        );
      case "completion":
        return this.requestByUri(
          args,
          opts,
          {
            argsSchema: TextDocumentPositionArgsSchema,
            lspMethod: "textDocument/completion",
            capabilityKey: "completionProvider",
            emptyResponse: [],
            outSchema: z.array(CompletionItemSchema),
            params: textDocumentPositionParams,
            transform: normalizeCompletionResult,
          },
          "completion",
        );
      case "references":
        return this.requestByUri(
          args,
          opts,
          {
            argsSchema: ReferencesArgsSchema,
            lspMethod: "textDocument/references",
            capabilityKey: "referencesProvider",
            emptyResponse: [],
            outSchema: z.array(LocationSchema),
            params: referencesParams,
            transform: normalizeDefinitionResult,
          },
          "references",
        );
      case "documentHighlight":
        return this.requestByUri(
          args,
          opts,
          {
            argsSchema: TextDocumentPositionArgsSchema,
            lspMethod: "textDocument/documentHighlight",
            capabilityKey: "documentHighlightProvider",
            emptyResponse: [],
            outSchema: z.array(DocumentHighlightSchema),
            params: textDocumentPositionParams,
            transform: normalizeDocumentHighlightResult,
          },
          "documentHighlight",
        );
      case "documentSymbol":
        return this.requestByUri(
          args,
          opts,
          {
            argsSchema: DidCloseArgsSchema,
            lspMethod: "textDocument/documentSymbol",
            capabilityKey: "documentSymbolProvider",
            emptyResponse: [],
            outSchema: z.array(DocumentSymbolSchema),
            params: documentSymbolParams,
            transform: normalizeDocumentSymbolResult,
          },
          "documentSymbol",
        );
      case "workspaceSymbol":
        return this.workspaceSymbol(args, opts);
      case "semanticTokens":
        return this.semanticTokensByUri(args, opts);
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  notify(method: string, args: unknown): void {
    if (this.disposed) return;
    if (method === "fsChanged") {
      // Agent-backed LSP receives fs.changed inside the same workspace agent.
      return;
    }
    void args;
  }

  respondServerRequest(id: string | number, result: unknown): void {
    this.sendServerRequestResponse(id, { result });
  }

  rejectServerRequest(id: string | number, message: string): void {
    this.sendServerRequestResponse(id, {
      error: { code: -32603, message },
    });
  }

  on(event: string, cb: EventCallback): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(cb);
    return () => listeners?.delete(cb);
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.diagnosticsDebouncer.clearAll();
    for (const [, server] of this.serversById) {
      server.dispose();
    }
    this.serversById.clear();
    this.workspaceServers.clear();
    this.serverPromises.clear();
    this.uriIndex.clear();
    this.workspaceLastActivity.clear();
    this.serverTimeoutCount.clear();
    this.serverSpawnedAt.clear();
    this.pendingServerRequests.clear();
    this.pendingSpawnByCorrelation.clear();
    this.pendingSpawnByServerId.clear();
    for (const disposers of this.channelDisposers.values()) {
      for (const dispose of disposers) dispose();
    }
    this.channelDisposers.clear();
    this.listeners.clear();
  }

  /**
   * Dispose the LSP server for a single (workspaceId, languageId) pair,
   * then broadcast a workspaceLspReset event for that language. No-op when
   * the server is not currently live. Called from the IPC layer when the user
   * toggles a language off via `setEnabledLanguages`.
   */
  disposeLanguage(workspaceId: string, languageId: string, reason: string): void {
    if (this.disposed) return;
    this.disposeWorkspaceServers(workspaceId, reason, { languageId });
  }

  private async didOpen(args: unknown): Promise<null> {
    const parsed = DidOpenArgsSchema.parse(args);
    const presetLanguageId = resolveLspPresetLanguageId(parsed.languageId);
    if (!presetLanguageId) return null;

    this.touchWorkspace(parsed.workspaceId);
    const server = await this.getOrCreateServer(
      parsed.workspaceId,
      parsed.languageId,
      parsed.workspaceRoot,
    );
    if (!server) return null;

    await server.notifyTextDocumentDidOpen({
      textDocument: {
        uri: parsed.uri,
        languageId: parsed.languageId,
        version: parsed.version,
        text: parsed.text,
      },
    });
    this.recordUriOwnership(parsed.workspaceId, parsed.uri, presetLanguageId);
    return null;
  }

  private async didChange(args: unknown): Promise<null> {
    const parsed = DidChangeArgsSchema.parse(args);
    const routed = this.findServer(parsed.workspaceId, parsed.uri);
    if (!routed) return null;
    this.touchWorkspace(parsed.workspaceId);

    await routed.server.notifyTextDocumentDidChange({
      textDocument: { uri: parsed.uri, version: parsed.version },
      contentChanges: parsed.contentChanges,
    });
    return null;
  }

  private async didSave(args: unknown): Promise<null> {
    const parsed = DidSaveArgsSchema.parse(args);
    const routed = this.findServer(parsed.workspaceId, parsed.uri);
    if (!routed) return null;
    this.touchWorkspace(parsed.workspaceId);

    await routed.server.notifyTextDocumentDidSave({
      textDocument: { uri: parsed.uri },
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
    });
    return null;
  }

  private async didClose(args: unknown): Promise<null> {
    const parsed = DidCloseArgsSchema.parse(args);
    const routed = this.findServer(parsed.workspaceId, parsed.uri);
    if (!routed) return null;
    this.touchWorkspace(parsed.workspaceId);

    await routed.server.notifyTextDocumentDidClose({
      textDocument: { uri: parsed.uri },
    });
    // Flush any pending diagnostics for this URI before it is removed from the
    // index — the renderer expects a final consistent state on close.
    this.diagnosticsDebouncer.flush(parsed.workspaceId, parsed.uri);
    this.dropUriOwnership(parsed.workspaceId, parsed.uri);
    return null;
  }

  private async requestByUri<A extends { workspaceId: string; uri: string }>(
    args: unknown,
    opts: LspHostCallOptions,
    spec: RequestSpec<A>,
    methodName: string,
  ) {
    const parsed = spec.argsSchema.parse(args);
    const routed = this.findServer(parsed.workspaceId, parsed.uri);
    if (!routed) {
      return spec.outSchema.parse(spec.emptyResponse);
    }
    if (!routed.server.hasCapability(spec.capabilityKey)) {
      return spec.outSchema.parse(spec.emptyResponse);
    }
    this.touchWorkspace(parsed.workspaceId);

    let raw: unknown;
    try {
      raw = await withRequestTimeout(
        (signal) => routed.server.request(spec.lspMethod, spec.params(parsed), { signal }),
        opts.signal,
        methodName,
      );
    } catch (error) {
      if (error instanceof LspRequestTimeoutError) {
        this.trackTimeout(routed.context.workspaceId, routed.context.languageId);
      }
      throw error;
    }
    this.resetTimeoutCount(routed.context.workspaceId, routed.context.languageId);
    const normalized = spec.transform ? spec.transform(raw) : raw;
    return spec.outSchema.parse(normalized);
  }

  private async semanticTokensByUri(args: unknown, opts: LspHostCallOptions): Promise<unknown> {
    const parsed = SemanticTokensArgsSchema.parse(args);
    const routed = this.findServer(parsed.workspaceId, parsed.uri);
    if (!routed) return null;
    if (!routed.server.hasCapability("semanticTokensProvider")) return null;
    this.touchWorkspace(parsed.workspaceId);

    // Extract the server's token-type legend from its initialize-response
    // capabilities. The server capability is keyed "semanticTokensProvider"
    // and contains either { legend: { tokenTypes: string[] } } or a boolean.
    const serverLegend = extractServerTokenTypes(
      routed.server.getCapabilityValue("semanticTokensProvider"),
    );

    let raw: unknown;
    try {
      raw = await withRequestTimeout(
        (signal) =>
          routed.server.request("textDocument/semanticTokens/full", semanticTokensParams(parsed), {
            signal,
          }),
        opts.signal,
        "semanticTokens",
      );
    } catch (error) {
      if (error instanceof LspRequestTimeoutError) {
        this.trackTimeout(routed.context.workspaceId, routed.context.languageId);
      }
      throw error;
    }
    this.resetTimeoutCount(routed.context.workspaceId, routed.context.languageId);

    const normalized = normalizeSemanticTokensResult(raw);
    if (!normalized) return SemanticTokensResultSchema.nullable().parse(null);

    // Remap server-legend indices → canonical-legend indices so the renderer
    // provider's getLegend() (which returns CANONICAL_TOKEN_TYPES) correctly
    // addresses every token in the data array.
    const remappedData = remapSemanticTokenData(
      normalized.data,
      serverLegend,
      CANONICAL_TOKEN_TYPES,
    );

    return SemanticTokensResultSchema.nullable().parse({
      resultId: normalized.resultId,
      data: remappedData,
    });
  }

  private async workspaceSymbol(args: unknown, opts: LspHostCallOptions): Promise<unknown[]> {
    const parsed = WorkspaceSymbolArgsSchema.parse(args);
    const servers = Array.from(
      this.workspaceServers.get(parsed.workspaceId)?.values() ?? [],
    ).filter((server) => server.hasCapability("workspaceSymbolProvider"));
    if (servers.length === 0) return [];
    this.touchWorkspace(parsed.workspaceId);

    const settled = await Promise.allSettled(
      servers.map(async (server) => {
        let raw: unknown;
        try {
          raw = await withRequestTimeout(
            (signal) => server.request("workspace/symbol", { query: parsed.query }, { signal }),
            opts.signal,
            "workspaceSymbol",
          );
        } catch (error) {
          if (error instanceof LspRequestTimeoutError) {
            this.trackTimeout(server.workspaceId, server.languageId);
          }
          throw error;
        }
        this.resetTimeoutCount(server.workspaceId, server.languageId);
        return normalizeWorkspaceSymbolResult(raw);
      }),
    );
    const merged: unknown[] = [];
    for (const item of settled) {
      if (item.status === "fulfilled" && Array.isArray(item.value)) {
        merged.push(...item.value);
      } else if (item.status === "rejected") {
        console.warn("[lsp-agent] workspace/symbol request failed", item.reason);
      }
    }
    return z.array(SymbolInformationSchema).parse(merged);
  }

  private async getOrCreateServer(
    workspaceId: string,
    languageId: string,
    workspaceRoot: string,
  ): Promise<AgentLspServer | null> {
    const preset = resolveLspPreset(languageId);
    const presetLanguageId = resolveLspPresetLanguageId(languageId);
    if (!preset || !presetLanguageId) return null;

    // Language-enabled gate: checked before looking up an existing server so
    // a toggle-off that already disposed the server doesn't accidentally
    // recreate it on the next didOpen from a still-open editor tab.
    if (!this.isLanguageEnabled(workspaceId, presetLanguageId)) return null;

    const existing = this.workspaceServers.get(workspaceId)?.get(presetLanguageId);
    if (existing) return existing;

    const key = `${workspaceId}\0${presetLanguageId}`;
    const pending = this.serverPromises.get(key);
    if (pending) return pending;

    // Before allocating a brand-new server for this workspace, make
    // room: if N other workspaces are already live, evict the LRU one.
    // Eviction emits a "workspaceLspReset" event so the renderer can
    // reset its `lspOpened` markers and re-issue didOpen on the next
    // interaction. See LSP_MAX_ACTIVE_WORKSPACES for the rationale.
    this.evictLruWorkspaceIfNeeded(workspaceId);

    const promise = this.spawnServer(workspaceId, presetLanguageId, workspaceRoot, preset).finally(
      () => {
        this.serverPromises.delete(key);
      },
    );
    this.serverPromises.set(key, promise);
    return promise;
  }

  /**
   * Update the LRU clock for `workspaceId`. Called from every code
   * path that resolves to a live server — didOpen/didChange/didSave/
   * didClose, request-style methods (hover, definition, …), and
   * workspaceSymbol. The "currently used" set is therefore exactly the
   * set of workspaces with recent activity, and the eviction policy
   * picks off the oldest first.
   */
  private touchWorkspace(workspaceId: string): void {
    this.workspaceLastActivity.set(workspaceId, Date.now());
  }

  /**
   * Find and dispose the least-recently-used workspace's LSP servers
   * when adding a new workspace would push the live count past the
   * cap. The workspace currently being spawned is excluded from the
   * candidate set so we never evict the workspace that just touched
   * `getOrCreateServer`.
   *
   * Emits the `workspaceLspReset` event so the renderer can clear
   * `lspOpened` on the evicted workspace's entries; the next user
   * interaction (typing, workspace activation) triggers a fresh
   * didOpen and respawns the LSP.
   */
  private evictLruWorkspaceIfNeeded(activeWorkspaceId: string): void {
    if (this.workspaceServers.has(activeWorkspaceId)) return;
    if (this.workspaceServers.size < this.maxActiveWorkspaces) return;

    let lruWorkspaceId: string | null = null;
    let lruTime = Number.POSITIVE_INFINITY;
    for (const wsId of this.workspaceServers.keys()) {
      if (wsId === activeWorkspaceId) continue;
      const t = this.workspaceLastActivity.get(wsId) ?? 0;
      if (t < lruTime) {
        lruTime = t;
        lruWorkspaceId = wsId;
      }
    }
    if (lruWorkspaceId) {
      this.disposeWorkspaceServers(lruWorkspaceId, "evicted by LRU cap");
    }
  }

  /**
   * Dispose LSP server(s) for `workspaceId`. When `options.languageId` is
   * provided only the server for that language is disposed; otherwise every
   * server for the workspace is disposed (full workspace reset).
   *
   * Broadcasts a `workspaceLspReset` event so the renderer-side model cache
   * resets `lspOpened` on affected entries. Idempotent — a second call for
   * the same (workspaceId[, languageId]) that is already gone is a no-op.
   */
  private disposeWorkspaceServers(
    workspaceId: string,
    reason: string,
    options?: { languageId?: string },
  ): void {
    const servers = this.workspaceServers.get(workspaceId);
    if (!servers) return;

    const targetLanguageId = options?.languageId;

    if (targetLanguageId) {
      // Single-language dispose: only remove the specified server.
      const server = servers.get(targetLanguageId);
      if (!server) return;
      this.diagnosticsDebouncer.clearForServer(server.workspaceId, server.languageId);
      this.dropUriOwnershipForServer(server.workspaceId, server.languageId);
      this.serversById.delete(server.serverId);
      server.dispose();
      servers.delete(targetLanguageId);
      const serverKey = `${workspaceId}\0${targetLanguageId}`;
      this.serverTimeoutCount.delete(serverKey);
      this.serverSpawnedAt.delete(serverKey);
      if (servers.size === 0) {
        this.workspaceServers.delete(workspaceId);
        this.workspaceLastActivity.delete(workspaceId);
      }
      this.emit("workspaceLspReset", { workspaceId, languageId: targetLanguageId, reason });
    } else {
      // Full workspace dispose.
      for (const server of servers.values()) {
        this.diagnosticsDebouncer.clearForServer(server.workspaceId, server.languageId);
        this.dropUriOwnershipForServer(server.workspaceId, server.languageId);
        this.serversById.delete(server.serverId);
        server.dispose();
        const serverKey = `${workspaceId}\0${server.languageId}`;
        this.serverTimeoutCount.delete(serverKey);
        this.serverSpawnedAt.delete(serverKey);
      }
      this.workspaceServers.delete(workspaceId);
      this.workspaceLastActivity.delete(workspaceId);
      this.emit("workspaceLspReset", { workspaceId, reason });
    }
  }

  private async spawnServer(
    workspaceId: string,
    presetLanguageId: string,
    workspaceRoot: string,
    preset: LspServerSpec,
  ): Promise<AgentLspServer> {
    const channel = await this.workspaceManager.getAgentChannel(workspaceId);
    await channel.ready;
    this.subscribeChannel(channel);
    this.storeInitializationOptions(workspaceId, presetLanguageId, preset.initializationOptions);

    const correlationId = randomUUID();
    const pendingSpawn: PendingSpawn = {
      channel,
      workspaceId,
      languageId: presetLanguageId,
      correlationId,
    };
    this.pendingSpawnByCorrelation.set(correlationId, pendingSpawn);

    let serverId: string | null = null;
    try {
      const command = await this.resolveServerCommand(workspaceId, presetLanguageId, preset);
      const result = await channel.call<AgentSpawnResult>("lsp.spawn", {
        workspaceId,
        languageId: presetLanguageId,
        binaryPath: command.binaryPath,
        args: [...command.args],
        workspaceRoot,
        idleTimeoutMs: LSP_DEFAULT_IDLE_MS,
        correlationId,
        capabilities: LSP_CLIENT_CAPABILITIES,
      });
      serverId = parseSpawnResult(result).serverId;
      const capabilities = parseServerCapabilities(result.capabilities);
      const server = new AgentLspServer({
        channel,
        serverId,
        workspaceId,
        languageId: presetLanguageId,
        capabilities,
      });
      this.rememberServer(server);
      return server;
    } finally {
      this.pendingSpawnByCorrelation.delete(correlationId);
      if (serverId) {
        this.pendingSpawnByServerId.delete(serverId);
      }
    }
  }

  private async resolveServerCommand(
    workspaceId: string,
    languageId: string,
    preset: LspServerSpec,
  ): Promise<{ readonly binaryPath: string; readonly args: readonly string[] }> {
    const remote = await this.workspaceManager.ensureRemoteLspServer?.(
      workspaceId,
      {
        binaryName: preset.binary,
        languageId,
        args: preset.args,
      },
      (event) => {
        this.emit(LSP_BOOTSTRAP_PROGRESS_EVENT, {
          workspaceId,
          languageId,
          ...event,
        });
      },
    );
    if (remote) return remote;
    return resolveLocalLspCommand(preset);
  }

  private rememberServer(server: AgentLspServer): void {
    let workspaceServers = this.workspaceServers.get(server.workspaceId);
    if (!workspaceServers) {
      workspaceServers = new Map();
      this.workspaceServers.set(server.workspaceId, workspaceServers);
    }
    workspaceServers.set(server.languageId, server);
    this.serversById.set(server.serverId, server);
    // Record spawn time so trackTimeout can enforce the grace window during
    // which slow-to-initialize servers are not wedge-restarted.
    const serverKey = `${server.workspaceId}\0${server.languageId}`;
    this.serverSpawnedAt.set(serverKey, Date.now());
    // Reset any leftover timeout count from a previous server instance for
    // this (workspace, language) slot (e.g. after a wedge-restart).
    this.serverTimeoutCount.delete(serverKey);
  }

  /**
   * Resolve the LSP server that owns `(workspaceId, uri)`. Returns null
   * when the workspace has not opened this URI (yet, or any more — the
   * common case during workspace switches when a model is mounted but
   * didOpen hasn't routed). Callers must handle null gracefully.
   *
   * Pairs intentionally route by both workspaceId AND uri: two workspaces
   * holding the same physical file each have their own LSP server
   * instance, and routing by uri alone would conflate them.
   */
  private findServer(
    workspaceId: string,
    uri: string,
  ): { server: AgentLspServer; context: ServerContext } | null {
    const presetLanguageId = this.uriIndex.get(workspaceId)?.get(uri);
    if (!presetLanguageId) return null;
    const server = this.workspaceServers.get(workspaceId)?.get(presetLanguageId);
    return server ? { server, context: { workspaceId, languageId: presetLanguageId } } : null;
  }

  /** Record which preset language owns `(workspaceId, uri)` after didOpen. */
  private recordUriOwnership(workspaceId: string, uri: string, presetLanguageId: string): void {
    let workspaceMap = this.uriIndex.get(workspaceId);
    if (!workspaceMap) {
      workspaceMap = new Map();
      this.uriIndex.set(workspaceId, workspaceMap);
    }
    workspaceMap.set(uri, presetLanguageId);
  }

  /** Drop the URI's index entry on didClose, leaving the workspace's other URIs intact. */
  private dropUriOwnership(workspaceId: string, uri: string): void {
    const workspaceMap = this.uriIndex.get(workspaceId);
    if (!workspaceMap) return;
    workspaceMap.delete(uri);
    if (workspaceMap.size === 0) this.uriIndex.delete(workspaceId);
  }

  private subscribeChannel(channel: AgentChannel): void {
    if (this.channelDisposers.has(channel)) return;

    const offMessage = channel.on("lsp.message", (payload) => {
      this.handleAgentMessage(channel, payload);
    });
    const offServerRequest = channel.on("lsp.serverRequest", (payload) => {
      this.handleAgentServerRequest(channel, payload);
    });
    const offServerAssigned = channel.on("lsp.serverAssigned", (payload) => {
      this.handleServerAssigned(payload);
    });
    const offServerExited = channel.on("lsp.serverExited", (payload) => {
      this.handleServerExited(payload);
    });
    const offLifecycle = channel.onLifecycle((event) => {
      // `reconnecting` is transient and the channel may yet recover. Leave
      // server records intact so queued LSP calls replay onto the new agent
      // once the channel completes its reconnect handshake.
      if (event.type === "reconnecting") return;
      this.disposeChannelServers(channel);
    });
    this.channelDisposers.set(channel, [
      offMessage,
      offServerRequest,
      offServerAssigned,
      offServerExited,
      offLifecycle,
    ]);
  }

  private handleServerAssigned(payload: unknown): void {
    const parsed = parseServerAssignedPayload(payload);
    if (!parsed?.correlationId) return;

    const pending = this.pendingSpawnByCorrelation.get(parsed.correlationId);
    if (!pending) return;
    this.pendingSpawnByServerId.set(parsed.serverId, pending);
  }

  private handleServerExited(payload: unknown): void {
    const parsed = parseServerExitedPayload(payload);
    if (!parsed) return;

    const server = this.serversById.get(parsed.serverId);
    if (server) {
      // Clear diagnostics timers for all URIs owned by the dead server before
      // any further cleanup. Firing stale trailing-edge timers after the server
      // has exited would push obsolete squiggle data to the renderer.
      this.diagnosticsDebouncer.clearForServer(server.workspaceId, server.languageId);

      // Reject in-flight client requests with a server-exit error so the
      // renderer's promise chain unwinds rather than waiting on a now-dead
      // process. Channel listeners are intentionally left in place — the
      // channel itself is still alive and may carry other servers.
      server.disposePending(serverExitError(parsed));
      this.serversById.delete(parsed.serverId);
      this.workspaceServers.get(server.workspaceId)?.delete(server.languageId);
      this.dropUriOwnershipForServer(server.workspaceId, server.languageId);

      // Clean up wedge-detection state for the exited server so a respawn
      // starts with a fresh count and spawn timestamp.
      const serverKey = `${server.workspaceId}\0${server.languageId}`;
      this.serverTimeoutCount.delete(serverKey);
      this.serverSpawnedAt.delete(serverKey);
    }

    // applyEdit-style server requests held in pendingServerRequests are
    // orphaned when the LSP exits mid-request; the renderer-side promise
    // would otherwise sit until APPLY_EDIT_RESPONSE_TIMEOUT_MS. Drop them
    // explicitly here so the timeout path is reserved for actual hangs.
    for (const [id, pending] of this.pendingServerRequests) {
      if (pending.serverId === parsed.serverId) {
        this.pendingServerRequests.delete(id);
      }
    }
    this.pendingSpawnByServerId.delete(parsed.serverId);
  }

  private disposeChannelServers(channel: AgentChannel): void {
    for (const server of Array.from(this.serversById.values())) {
      if (server.channel !== channel) continue;
      // Clear diagnostics timers before removing the URI index entries so the
      // predicate in clearDiagnosticsTimersForServer can still resolve the URI
      // → server mapping. Mirrors the ordering used in handleServerExited.
      this.diagnosticsDebouncer.clearForServer(server.workspaceId, server.languageId);
      server.dispose();
      this.serversById.delete(server.serverId);
      this.workspaceServers.get(server.workspaceId)?.delete(server.languageId);
      this.dropUriOwnershipForServer(server.workspaceId, server.languageId);
    }
  }

  private handleAgentMessage(channel: AgentChannel, payload: unknown): void {
    const parsed = parseAgentMessagePayload(payload);
    if (!parsed) return;

    const server = this.serversById.get(parsed.serverId);
    if (server) {
      if (!server.handleMessage(parsed.message)) {
        this.handleServerNotification(
          { workspaceId: server.workspaceId, languageId: server.languageId },
          parsed.message,
        );
      }
      return;
    }

    const context = this.serverContextFor(channel, parsed.serverId);
    if (!context) return;
    this.handleServerNotification(context, parsed.message);
  }

  private handleAgentServerRequest(channel: AgentChannel, payload: unknown): void {
    const parsed = parseAgentServerRequestPayload(payload);
    if (!parsed) return;

    const context = this.serverContextFor(channel, parsed.serverId);
    if (!context) {
      void this.respondAgentServerRequest(channel, parsed.serverId, parsed.agentRequestId, {
        error: { code: -32603, message: "LSP server is not registered" },
      });
      return;
    }

    switch (parsed.method) {
      case "workspace/applyEdit":
        this.emitApplyEditRequest(channel, parsed);
        return;
      case "workspace/configuration":
        void this.respondAgentServerRequest(channel, parsed.serverId, parsed.agentRequestId, {
          result: this.workspaceConfiguration(context, parsed.params),
        });
        return;
      case "client/registerCapability":
        void this.respondAgentServerRequest(channel, parsed.serverId, parsed.agentRequestId, {
          result: null,
        });
        return;
      case "window/showMessageRequest":
        this.emitServerEvent(context, "window/showMessageRequest", parsed.params);
        void this.respondAgentServerRequest(channel, parsed.serverId, parsed.agentRequestId, {
          result: firstShowMessageAction(parsed.params),
        });
        return;
      case "window/workDoneProgress/create":
        this.emitServerEvent(
          context,
          "window/workDoneProgress/create",
          parseWorkDoneProgressCreateParams(parsed.params),
        );
        void this.respondAgentServerRequest(channel, parsed.serverId, parsed.agentRequestId, {
          result: null,
        });
        return;
      default:
        void this.respondAgentServerRequest(channel, parsed.serverId, parsed.agentRequestId, {
          error: { code: -32601, message: `unsupported server request: ${parsed.method}` },
        });
    }
  }

  private emitApplyEditRequest(
    channel: AgentChannel,
    request: { serverId: string; agentRequestId: string; method: string; params: unknown },
  ): void {
    const parsed = ApplyWorkspaceEditParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void this.respondAgentServerRequest(channel, request.serverId, request.agentRequestId, {
        result: { applied: false, failureReason: "Invalid workspace/applyEdit params" },
      });
      return;
    }

    const id = `agent-apply-edit-${this.nextServerRequestId++}`;
    this.pendingServerRequests.set(id, {
      channel,
      serverId: request.serverId,
      agentRequestId: request.agentRequestId,
    });
    this.emit("serverRequest", { id, method: request.method, params: parsed.data });
  }

  private sendServerRequestResponse(
    id: string | number,
    response: { result?: unknown; error?: unknown },
  ): void {
    const pending = this.pendingServerRequests.get(String(id));
    if (!pending || this.disposed) return;
    this.pendingServerRequests.delete(String(id));
    void this.respondAgentServerRequest(
      pending.channel,
      pending.serverId,
      pending.agentRequestId,
      response,
    );
  }

  private async respondAgentServerRequest(
    channel: AgentChannel,
    serverId: string,
    agentRequestId: string,
    response: { result?: unknown; error?: unknown },
  ): Promise<void> {
    try {
      await channel.call("lsp.respondServerRequest", {
        serverId,
        agentRequestId,
        ...response,
      });
    } catch (error) {
      console.warn("[lsp-agent] failed to respond to server request", error);
    }
  }

  private handleServerNotification(context: ServerContext, message: unknown): void {
    const msg = asRecord(message);
    if (!msg || typeof msg.method !== "string" || "id" in msg) return;

    if (msg.method === "textDocument/publishDiagnostics") {
      const parsed = parsePublishDiagnostics(msg.params);
      if (parsed) {
        // Attach workspace + language context so the debouncer payload
        // emitted to the renderer carries everything the diagnostics
        // listener needs to reconstruct the right Monaco model's
        // cacheUri. Without workspaceId, two workspaces holding the same
        // physical file would write into the same marker layer.
        this.diagnosticsDebouncer.schedule({
          workspaceId: context.workspaceId,
          languageId: context.languageId,
          uri: parsed.uri,
          diagnostics: parsed.diagnostics,
        });
      }
      return;
    }

    if (SERVER_EVENT_METHODS.has(msg.method)) {
      this.emitServerEvent(context, msg.method as LspServerEventMethod, msg.params);
    }
  }

  private emitServerEvent(context: ServerContext, method: LspServerEventMethod, params: unknown) {
    this.emit("serverEvent", {
      workspaceId: context.workspaceId,
      languageId: context.languageId,
      method,
      params,
    });
  }

  private workspaceConfiguration(context: ServerContext, params: unknown): unknown[] {
    const parsed = ConfigurationParamsSchema.safeParse(params);
    if (!parsed.success) return [];

    const flatConfig = this.configurationStore.get(context.workspaceId)?.get(context.languageId);
    return parsed.data.items.map((item) => {
      if (!flatConfig || typeof item.section !== "string" || item.section.length === 0) {
        return null;
      }
      return lookupFlattenedConfig(flatConfig, item.section);
    });
  }

  private storeInitializationOptions(
    workspaceId: string,
    languageId: string,
    initializationOptions: unknown,
  ): void {
    let workspaceConfig = this.configurationStore.get(workspaceId);
    if (!workspaceConfig) {
      workspaceConfig = new Map();
      this.configurationStore.set(workspaceId, workspaceConfig);
    }
    workspaceConfig.set(languageId, flattenInitializationOptions(initializationOptions));
  }

  private serverContextFor(_channel: AgentChannel, serverId: string): ServerContext | null {
    // Resolution path is now deterministic: serversById carries the server
    // once spawn returns, and pendingSpawnByServerId is populated by the
    // lsp.serverAssigned event before initialize finishes. No fallback to
    // "first pending spawn on channel" — that heuristic mis-attributed
    // pre-spawn-resolution events when two languages spawned concurrently.
    const server = this.serversById.get(serverId);
    if (server) {
      return { workspaceId: server.workspaceId, languageId: server.languageId };
    }
    const pending = this.pendingSpawnByServerId.get(serverId);
    return pending ? { workspaceId: pending.workspaceId, languageId: pending.languageId } : null;
  }

  /**
   * Drop every URI owned by the (workspaceId, presetLanguageId) server,
   * collapsing the workspace's inner map when it becomes empty. Called
   * from the server-exited and channel-dispose paths so a torn-down LSP
   * does not leave stale entries that would mis-route subsequent
   * requests for the same workspace + URI to a defunct server.
   */
  private dropUriOwnershipForServer(workspaceId: string, presetLanguageId: string): void {
    const workspaceMap = this.uriIndex.get(workspaceId);
    if (!workspaceMap) return;
    for (const [uri, owningPreset] of workspaceMap) {
      if (owningPreset === presetLanguageId) workspaceMap.delete(uri);
    }
    if (workspaceMap.size === 0) this.uriIndex.delete(workspaceId);
  }

  /**
   * Record a timeout for the `(workspaceId, languageId)` server. Calls
   * within LSP_SERVER_WEDGE_GRACE_MS of the server's spawn time are
   * silently ignored — some language servers (tsserver, basedpyright)
   * are slow to finish initialisation and would otherwise be cycled
   * immediately. Once the grace window has elapsed, every call increments
   * the consecutive counter; reaching LSP_CONSECUTIVE_TIMEOUT_LIMIT
   * triggers `disposeWorkspaceServers` with the specific `languageId`.
   */
  private trackTimeout(workspaceId: string, languageId: string): void {
    const serverKey = `${workspaceId}\0${languageId}`;
    const spawnedAt = this.serverSpawnedAt.get(serverKey);
    if (spawnedAt !== undefined && Date.now() - spawnedAt < LSP_SERVER_WEDGE_GRACE_MS) {
      // Inside grace window — do not count.
      return;
    }
    const count = (this.serverTimeoutCount.get(serverKey) ?? 0) + 1;
    if (count >= LSP_CONSECUTIVE_TIMEOUT_LIMIT) {
      this.serverTimeoutCount.delete(serverKey);
      console.warn(
        `[lsp-agent] ${workspaceId}/${languageId} wedged (${LSP_CONSECUTIVE_TIMEOUT_LIMIT} consecutive timeouts) — restarting`,
      );
      this.disposeWorkspaceServers(workspaceId, "LSP server wedged (3 consecutive timeouts)", {
        languageId,
      });
    } else {
      this.serverTimeoutCount.set(serverKey, count);
    }
  }

  /**
   * Reset the consecutive-timeout counter for the `(workspaceId,
   * languageId)` server. Called whenever a request completes successfully
   * so a single transient stall followed by a recovery is not penalised.
   */
  private resetTimeoutCount(workspaceId: string, languageId: string): void {
    const serverKey = `${workspaceId}\0${languageId}`;
    this.serverTimeoutCount.delete(serverKey);
  }

  private emit(event: string, args: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb(args);
    }
  }
}

interface RequestSpec<A> {
  argsSchema: z.ZodType<A>;
  lspMethod: string;
  capabilityKey: string;
  emptyResponse: unknown;
  outSchema: z.ZodTypeAny;
  params: (args: A) => unknown;
  transform?: (raw: unknown) => unknown;
}

/**
 * Run an LSP request under a wall-clock budget. On expiry an internal
 * AbortController fires, cancelling the request at the server boundary
 * (via the signal the agent-lsp-server consumes), and the function
 * rejects with `LspRequestTimeoutError`. The caller (the IPC layer)
 * recognises that error and returns the method-appropriate empty value
 * instead of letting it crash through the renderer's provider.
 *
 * The external signal (renderer-side cancellation) is composed with the
 * internal one so either trigger cancels the request. A cancellation
 * from the renderer is allowed to propagate as a plain abort error —
 * the IPC layer already swallows those.
 */
async function withRequestTimeout<T>(
  exec: (signal: AbortSignal) => Promise<T>,
  externalSignal: AbortSignal | undefined,
  methodName: string,
): Promise<T> {
  const timeoutMs = REQUEST_TIMEOUT_MS[methodName];
  if (timeoutMs === undefined) {
    // No bounded budget configured for this method — pass through
    // unchanged. Used as a defensive default; we intentionally list
    // every routable method in REQUEST_TIMEOUT_MS.
    return exec(externalSignal ?? new AbortController().signal);
  }

  const internal = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => internal.abort();
  if (externalSignal) {
    if (externalSignal.aborted) internal.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    internal.abort();
  }, timeoutMs);

  try {
    return await exec(internal.signal);
  } catch (error) {
    if (timedOut && !externalSignal?.aborted) {
      throw new LspRequestTimeoutError(methodName, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// Local LSP command resolution
// ---------------------------------------------------------------------------

// resolveLocalLspCommand returns the binary the local agent should spawn for
// the requested LSP preset. Production-style runs read the dist/agent
// manifest emitted by scripts/build-agent.ts and launch the extracted Node
// entry directly via the user's `node` (matching the SSH launcher script
// format, but without bundling Node for local). Dev runs without a built
// dist fall back to node_modules/.bin so `bun run dev` keeps working.
function resolveLocalLspCommand(preset: LspServerSpec): {
  readonly binaryPath: string;
  readonly args: readonly string[];
} {
  const fromManifest = resolveLspCommandFromManifest(preset);
  if (fromManifest) return fromManifest;
  return { binaryPath: resolveDevBundledBinary(preset.binary), args: preset.args };
}

function resolveLspCommandFromManifest(preset: LspServerSpec): {
  readonly binaryPath: string;
  readonly args: readonly string[];
} | null {
  const manifestPath = path.join(LOCAL_AGENT_DIST_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = AgentManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const lsp = findLspBinary(manifest, { name: preset.binary });
    if (!lsp) return null;
    const extractedDir = path.join(LOCAL_AGENT_DIST_DIR, "lsp", `${lsp.name}-${lsp.version}`);
    const entry = path.join(extractedDir, lsp.entry);
    if (!fs.existsSync(entry)) return null;
    return { binaryPath: "node", args: [entry, ...preset.args] };
  } catch {
    return null;
  }
}

function resolveDevBundledBinary(binary: string): string {
  const bundledPath = path.resolve(__dirname, "../../../node_modules/.bin", binary);
  if (fs.existsSync(bundledPath)) return bundledPath;
  return path.resolve(process.cwd(), "node_modules/.bin", binary);
}

// ---------------------------------------------------------------------------
// LSP request param shapers (kept here because they shape the args the
// host's call() switch already validated against the per-method schema).
// ---------------------------------------------------------------------------

function textDocumentPositionParams(args: { uri: string; line: number; character: number }) {
  return {
    textDocument: { uri: args.uri },
    position: { line: args.line, character: args.character },
  };
}

function referencesParams(args: {
  uri: string;
  line: number;
  character: number;
  includeDeclaration: boolean;
}) {
  return {
    ...textDocumentPositionParams(args),
    context: { includeDeclaration: args.includeDeclaration },
  };
}

function documentSymbolParams(args: { uri: string }) {
  return { textDocument: { uri: args.uri } };
}

function semanticTokensParams(args: { uri: string }) {
  return { textDocument: { uri: args.uri } };
}

function normalizeSemanticTokensResult(raw: unknown): { resultId?: string; data: number[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.data)) return null;
  return {
    resultId: typeof r.resultId === "string" ? r.resultId : undefined,
    data: r.data as number[],
  };
}

// Extracts the server's token-type name list from the semanticTokensProvider
// capability value as returned in the LSP initialize response. Returns an
// empty array (no-op remap) when the legend is absent or malformed.
function extractServerTokenTypes(capabilityValue: unknown): string[] {
  if (!capabilityValue || typeof capabilityValue !== "object") return [];
  const cap = capabilityValue as Record<string, unknown>;
  const legend = cap.legend;
  if (!legend || typeof legend !== "object") return [];
  const tokenTypes = (legend as Record<string, unknown>).tokenTypes;
  if (!Array.isArray(tokenTypes)) return [];
  return tokenTypes.filter((t): t is string => typeof t === "string");
}
