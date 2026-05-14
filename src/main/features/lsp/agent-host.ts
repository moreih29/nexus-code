import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ApplyWorkspaceEditParamsSchema,
  ConfigurationParamsSchema,
  type LspServerEventMethod,
  TextDocumentContentChangeEventSchema,
  TextDocumentIdentifierSchema,
  TextDocumentItemSchema,
  TextDocumentPositionArgsSchema,
  ReferencesArgsSchema,
  HoverResultSchema,
  LocationSchema,
  CompletionItemSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  SymbolInformationSchema,
} from "../../../shared/lsp";
import { AgentManifestSchema, findLspBinary } from "../../../shared/agent-manifest";
import { LOCAL_AGENT_DIST_DIR } from "../../infra/agent/ssh-bootstrap";
import {
  type LspServerSpec,
  resolveLspPreset,
  resolveLspPresetLanguageId,
} from "../../../shared/lsp-config";
import { LSP_DEFAULT_IDLE_MS } from "../../../shared/timing-constants";
import type { AgentChannel } from "../../infra/agent/channel";
import {
  LSP_BOOTSTRAP_PROGRESS_EVENT,
  type LspBootstrapProgressEvent,
} from "../../infra/agent/ssh-bootstrap";
import type { LspHostCallOptions, LspHostHandle } from "./host";
import { AgentLspServer } from "./agent-lsp-server";
import { asRecord } from "./lsp-utils";
import { flattenInitializationOptions, lookupFlattenedConfig } from "./lsp-config-store";
import {
  normalizeCompletionResult,
  normalizeDefinitionResult,
  normalizeDocumentHighlightResult,
  normalizeDocumentSymbolResult,
  normalizeHoverResult,
  normalizeWorkspaceSymbolResult,
  parsePublishDiagnostics,
} from "./lsp-result-normalizers";
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
} from "./lsp-payloads";

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

const DidChangeArgsSchema = z.object({
  uri: TextDocumentIdentifierSchema.shape.uri,
  version: TextDocumentItemSchema.shape.version,
  contentChanges: z.array(TextDocumentContentChangeEventSchema),
});

const DidSaveArgsSchema = z.object({
  uri: TextDocumentIdentifierSchema.shape.uri,
  text: TextDocumentItemSchema.shape.text.optional(),
});

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
// Host
// ---------------------------------------------------------------------------

export function startAgentLspHost(workspaceManager: AgentLspWorkspaceManager): LspHostHandle {
  return new AgentLspHostHandleImpl(workspaceManager);
}

class AgentLspHostHandleImpl implements LspHostHandle {
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly workspaceServers = new Map<string, Map<string, AgentLspServer>>();
  private readonly serversById = new Map<string, AgentLspServer>();
  private readonly serverPromises = new Map<string, Promise<AgentLspServer | null>>();
  private readonly uriIndex = new Map<string, { workspaceId: string; presetLanguageId: string }>();
  private readonly configurationStore = new Map<string, Map<string, Map<string, unknown>>>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly channelDisposers = new Map<AgentChannel, Array<() => void>>();
  // correlationId is assigned client-side before lsp.spawn so the agent can
  // echo it back via the lsp.serverAssigned event before initialize finishes.
  // Both maps are populated up front and dropped once the spawn round-trip
  // completes (or fails).
  private readonly pendingSpawnByCorrelation = new Map<string, PendingSpawn>();
  private readonly pendingSpawnByServerId = new Map<string, PendingSpawn>();
  private nextServerRequestId = 1;
  private disposed = false;

  constructor(private readonly workspaceManager: AgentLspWorkspaceManager) {}

  async call(method: string, args: unknown, opts: LspHostCallOptions = {}): Promise<unknown> {
    if (this.disposed) {
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
        return this.requestByUri(args, opts, {
          argsSchema: TextDocumentPositionArgsSchema,
          lspMethod: "textDocument/hover",
          capabilityKey: "hoverProvider",
          emptyResponse: null,
          outSchema: HoverResultSchema.nullable(),
          params: textDocumentPositionParams,
          transform: normalizeHoverResult,
        });
      case "definition":
        return this.requestByUri(args, opts, {
          argsSchema: TextDocumentPositionArgsSchema,
          lspMethod: "textDocument/definition",
          capabilityKey: "definitionProvider",
          emptyResponse: [],
          outSchema: z.array(LocationSchema),
          params: textDocumentPositionParams,
          transform: normalizeDefinitionResult,
        });
      case "completion":
        return this.requestByUri(args, opts, {
          argsSchema: TextDocumentPositionArgsSchema,
          lspMethod: "textDocument/completion",
          capabilityKey: "completionProvider",
          emptyResponse: [],
          outSchema: z.array(CompletionItemSchema),
          params: textDocumentPositionParams,
          transform: normalizeCompletionResult,
        });
      case "references":
        return this.requestByUri(args, opts, {
          argsSchema: ReferencesArgsSchema,
          lspMethod: "textDocument/references",
          capabilityKey: "referencesProvider",
          emptyResponse: [],
          outSchema: z.array(LocationSchema),
          params: referencesParams,
          transform: normalizeDefinitionResult,
        });
      case "documentHighlight":
        return this.requestByUri(args, opts, {
          argsSchema: TextDocumentPositionArgsSchema,
          lspMethod: "textDocument/documentHighlight",
          capabilityKey: "documentHighlightProvider",
          emptyResponse: [],
          outSchema: z.array(DocumentHighlightSchema),
          params: textDocumentPositionParams,
          transform: normalizeDocumentHighlightResult,
        });
      case "documentSymbol":
        return this.requestByUri(args, opts, {
          argsSchema: TextDocumentIdentifierSchema,
          lspMethod: "textDocument/documentSymbol",
          capabilityKey: "documentSymbolProvider",
          emptyResponse: [],
          outSchema: z.array(DocumentSymbolSchema),
          params: documentSymbolParams,
          transform: normalizeDocumentSymbolResult,
        });
      case "workspaceSymbol":
        return this.workspaceSymbol(args, opts);
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
    for (const [, server] of this.serversById) {
      server.dispose();
    }
    this.serversById.clear();
    this.workspaceServers.clear();
    this.serverPromises.clear();
    this.uriIndex.clear();
    this.pendingServerRequests.clear();
    this.pendingSpawnByCorrelation.clear();
    this.pendingSpawnByServerId.clear();
    for (const disposers of this.channelDisposers.values()) {
      for (const dispose of disposers) dispose();
    }
    this.channelDisposers.clear();
    this.listeners.clear();
  }

  private async didOpen(args: unknown): Promise<null> {
    const parsed = DidOpenArgsSchema.parse(args);
    const presetLanguageId = resolveLspPresetLanguageId(parsed.languageId);
    if (!presetLanguageId) return null;

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
    this.uriIndex.set(parsed.uri, {
      workspaceId: parsed.workspaceId,
      presetLanguageId,
    });
    return null;
  }

  private async didChange(args: unknown): Promise<null> {
    const parsed = DidChangeArgsSchema.parse(args);
    const routed = this.findServerForUri(parsed.uri);
    if (!routed) return null;

    await routed.server.notifyTextDocumentDidChange({
      textDocument: { uri: parsed.uri, version: parsed.version },
      contentChanges: parsed.contentChanges,
    });
    return null;
  }

  private async didSave(args: unknown): Promise<null> {
    const parsed = DidSaveArgsSchema.parse(args);
    const routed = this.findServerForUri(parsed.uri);
    if (!routed) return null;

    await routed.server.notifyTextDocumentDidSave({
      textDocument: { uri: parsed.uri },
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
    });
    return null;
  }

  private async didClose(args: unknown): Promise<null> {
    const parsed = TextDocumentIdentifierSchema.parse(args);
    const routed = this.findServerForUri(parsed.uri);
    if (!routed) return null;

    await routed.server.notifyTextDocumentDidClose({
      textDocument: { uri: parsed.uri },
    });
    this.uriIndex.delete(parsed.uri);
    return null;
  }

  private async requestByUri<A>(args: unknown, opts: LspHostCallOptions, spec: RequestSpec<A>) {
    const parsed = spec.argsSchema.parse(args);
    const routed = this.findServerForUri((parsed as { uri: string }).uri);
    if (!routed) {
      return spec.outSchema.parse(spec.emptyResponse);
    }
    if (!routed.server.hasCapability(spec.capabilityKey)) {
      return spec.outSchema.parse(spec.emptyResponse);
    }

    const raw = await routed.server.request(spec.lspMethod, spec.params(parsed), {
      signal: opts.signal,
    });
    const normalized = spec.transform ? spec.transform(raw) : raw;
    return spec.outSchema.parse(normalized);
  }

  private async workspaceSymbol(args: unknown, opts: LspHostCallOptions): Promise<unknown[]> {
    const parsed = WorkspaceSymbolArgsSchema.parse(args);
    const servers = Array.from(
      this.workspaceServers.get(parsed.workspaceId)?.values() ?? [],
    ).filter((server) => server.hasCapability("workspaceSymbolProvider"));
    if (servers.length === 0) return [];

    const settled = await Promise.allSettled(
      servers.map(async (server) => {
        const raw = await server.request("workspace/symbol", { query: parsed.query }, opts);
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

    const existing = this.workspaceServers.get(workspaceId)?.get(presetLanguageId);
    if (existing) return existing;

    const key = `${workspaceId}\0${presetLanguageId}`;
    const pending = this.serverPromises.get(key);
    if (pending) return pending;

    const promise = this.spawnServer(workspaceId, presetLanguageId, workspaceRoot, preset).finally(
      () => {
        this.serverPromises.delete(key);
      },
    );
    this.serverPromises.set(key, promise);
    return promise;
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
  }

  private findServerForUri(uri: string): { server: AgentLspServer; context: ServerContext } | null {
    const entry = this.uriIndex.get(uri);
    if (!entry) return null;
    const server = this.workspaceServers.get(entry.workspaceId)?.get(entry.presetLanguageId);
    return server
      ? {
          server,
          context: { workspaceId: entry.workspaceId, languageId: entry.presetLanguageId },
        }
      : null;
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
    const offLifecycle = channel.onLifecycle(() => {
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
      // Reject in-flight client requests with a server-exit error so the
      // renderer's promise chain unwinds rather than waiting on a now-dead
      // process. Channel listeners are intentionally left in place — the
      // channel itself is still alive and may carry other servers.
      server.disposePending(serverExitError(parsed));
      this.serversById.delete(parsed.serverId);
      this.workspaceServers.get(server.workspaceId)?.delete(server.languageId);
      this.removeUriIndexEntriesWhere(
        (entry) =>
          entry.workspaceId === server.workspaceId && entry.presetLanguageId === server.languageId,
      );
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
      server.dispose();
      this.serversById.delete(server.serverId);
      this.workspaceServers.get(server.workspaceId)?.delete(server.languageId);
      this.removeUriIndexEntriesWhere(
        (entry) =>
          entry.workspaceId === server.workspaceId && entry.presetLanguageId === server.languageId,
      );
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
        this.emit("diagnostics", parsed);
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

  private removeUriIndexEntriesWhere(
    predicate: (entry: { workspaceId: string; presetLanguageId: string }) => boolean,
  ): void {
    for (const [uri, entry] of this.uriIndex) {
      if (predicate(entry)) {
        this.uriIndex.delete(uri);
      }
    }
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
