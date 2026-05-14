import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ApplyWorkspaceEditParamsSchema,
  CompletionItemSchema,
  ConfigurationParamsSchema,
  DiagnosticSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  HoverResultSchema,
  LocationLinkSchema,
  LocationSchema,
  type LspServerEventMethod,
  MarkupContentSchema,
  RangeSchema,
  ReferencesArgsSchema,
  type ServerCapabilities,
  ServerCapabilitiesSchema,
  ShowMessageRequestParamsSchema,
  SymbolInformationSchema,
  TextDocumentContentChangeEventSchema,
  TextDocumentIdentifierSchema,
  TextDocumentItemSchema,
  TextDocumentPositionArgsSchema,
  TextDocumentSyncKind,
  type TextDocumentContentChangeEvent,
  type TextDocumentSyncKind as TextDocumentSyncKindValue,
  WorkDoneProgressCreateParamsSchema,
  type Location,
} from "../../../shared/lsp";
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

type EventCallback = (args: unknown) => void;
type JsonRpcId = string | number | null;
type PendingRequestId = string | number;

interface PendingClientRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface PendingServerRequest {
  channel: AgentChannel;
  serverId: string;
  agentRequestId: string;
}

interface PendingSpawn {
  channel: AgentChannel;
  workspaceId: string;
  languageId: string;
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
  private readonly pendingSpawnsByChannel = new Map<AgentChannel, PendingSpawn[]>();
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
    this.pendingSpawnsByChannel.clear();
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

    const pendingSpawn: PendingSpawn = {
      channel,
      workspaceId,
      languageId: presetLanguageId,
    };
    this.addPendingSpawn(pendingSpawn);

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
      this.removePendingSpawn(pendingSpawn);
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
    return { binaryPath: resolveBundledBinary(preset.binary), args: preset.args };
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
    const offLifecycle = channel.onLifecycle(() => {
      this.disposeChannelServers(channel);
    });
    this.channelDisposers.set(channel, [offMessage, offServerRequest, offLifecycle]);
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

  private serverContextFor(channel: AgentChannel, serverId: string): ServerContext | null {
    const server = this.serversById.get(serverId);
    if (server) {
      return { workspaceId: server.workspaceId, languageId: server.languageId };
    }

    let pending = this.pendingSpawnByServerId.get(serverId);
    if (!pending) {
      pending = this.pendingSpawnsByChannel.get(channel)?.[0];
      if (pending) {
        this.pendingSpawnByServerId.set(serverId, pending);
      }
    }
    return pending ? { workspaceId: pending.workspaceId, languageId: pending.languageId } : null;
  }

  private addPendingSpawn(pending: PendingSpawn): void {
    const spawns = this.pendingSpawnsByChannel.get(pending.channel) ?? [];
    spawns.push(pending);
    this.pendingSpawnsByChannel.set(pending.channel, spawns);
  }

  private removePendingSpawn(pending: PendingSpawn): void {
    const spawns = this.pendingSpawnsByChannel.get(pending.channel);
    if (!spawns) return;
    const index = spawns.indexOf(pending);
    if (index >= 0) spawns.splice(index, 1);
    if (spawns.length === 0) {
      this.pendingSpawnsByChannel.delete(pending.channel);
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

class AgentLspServer {
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

  private async sendMessage(message: unknown): Promise<void> {
    await this.channel.call("lsp.send", { serverId: this.serverId, message });
  }
}

function parseSpawnResult(result: unknown): AgentSpawnResult {
  const parsed = z
    .object({
      serverId: z.string().min(1),
      capabilities: z.unknown().optional(),
    })
    .parse(result);
  return parsed;
}

function parseServerCapabilities(capabilities: unknown): ServerCapabilities {
  const parsed = ServerCapabilitiesSchema.safeParse(capabilities);
  return parsed.success ? parsed.data : {};
}

function resolveBundledBinary(binary: string): string {
  const bundledPath = path.resolve(__dirname, "../../../node_modules/.bin", binary);
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }
  return path.resolve(process.cwd(), "node_modules/.bin", binary);
}

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

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isObjectLike(value) ? value : null;
}

function jsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  return null;
}

function capabilityValueIsSupported(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

function textDocumentSyncCapability(
  capabilities: ServerCapabilities,
): number | Record<string, unknown> | undefined {
  const value = capabilities.textDocumentSync;
  if (typeof value === "number" || isObjectLike(value)) return value;
  return undefined;
}

function validTextDocumentSyncKind(value: unknown): TextDocumentSyncKindValue | null {
  if (
    value === TextDocumentSyncKind.None ||
    value === TextDocumentSyncKind.Full ||
    value === TextDocumentSyncKind.Incremental
  ) {
    return value;
  }
  return null;
}

function negotiatedTextDocumentSyncKind(
  capabilities: ServerCapabilities,
): TextDocumentSyncKindValue {
  const sync = textDocumentSyncCapability(capabilities);
  const numeric = validTextDocumentSyncKind(sync);
  if (numeric !== null) return numeric;
  if (isObjectLike(sync)) {
    return validTextDocumentSyncKind(sync.change) ?? TextDocumentSyncKind.None;
  }
  return TextDocumentSyncKind.None;
}

function negotiatedTextDocumentOpenClose(capabilities: ServerCapabilities): boolean {
  const sync = textDocumentSyncCapability(capabilities);
  const numeric = validTextDocumentSyncKind(sync);
  if (numeric !== null) return numeric !== TextDocumentSyncKind.None;
  return isObjectLike(sync) && sync.openClose === true;
}

function negotiatedTextDocumentSave(capabilities: ServerCapabilities): {
  supported: boolean;
  includeText: boolean;
} {
  const sync = textDocumentSyncCapability(capabilities);
  if (!isObjectLike(sync)) return { supported: false, includeText: false };

  const save = sync.save;
  if (save === true) return { supported: true, includeText: false };
  if (isObjectLike(save)) {
    return { supported: true, includeText: save.includeText === true };
  }
  return { supported: false, includeText: false };
}

function reconstructMissingCache(
  contentChanges: readonly TextDocumentContentChangeEvent[],
): string | undefined {
  for (const change of contentChanges) {
    if (!("range" in change)) return change.text;
  }
  return undefined;
}

function applyTextDocumentContentChanges(
  text: string,
  contentChanges: readonly TextDocumentContentChangeEvent[],
): string {
  let nextText = text;
  for (const change of contentChanges) {
    if (!("range" in change)) {
      nextText = change.text;
      continue;
    }

    const start = offsetAt(nextText, change.range.start);
    const end = offsetAt(nextText, change.range.end);
    nextText = `${nextText.slice(0, start)}${change.text}${nextText.slice(end)}`;
  }
  return nextText;
}

function offsetAt(text: string, position: { line: number; character: number }): number {
  let index = 0;
  let line = 0;

  while (line < position.line && index < text.length) {
    const code = text.charCodeAt(index);
    index += 1;
    if (code === 13) {
      if (text.charCodeAt(index) === 10) index += 1;
      line += 1;
    } else if (code === 10) {
      line += 1;
    }
  }

  return Math.min(index + position.character, lineEndOffset(text, index));
}

function lineEndOffset(text: string, lineStart: number): number {
  let index = lineStart;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) break;
    index += 1;
  }
  return index;
}

function markedStringToMarkdown(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!isObjectLike(raw) || !("value" in raw)) return "";

  const value = raw.value;
  if (typeof value !== "string") return "";

  const language = raw.language;
  if (typeof language === "string" && language.length > 0) {
    return `\`\`\`${language}\n${value}\n\`\`\``;
  }
  return value;
}

function normalizeHoverContents(raw: unknown): unknown {
  const markup = MarkupContentSchema.safeParse(raw);
  if (markup.success) return markup.data;

  if (Array.isArray(raw)) {
    const text = raw.map(markedStringToMarkdown).filter(Boolean).join("\n\n");
    return text.length > 0 ? text : null;
  }

  if (typeof raw === "string") return raw;

  const marked = markedStringToMarkdown(raw);
  return marked.length > 0 ? marked : null;
}

function normalizeHoverResult(raw: unknown): unknown {
  if (!isObjectLike(raw)) return null;
  const contents = normalizeHoverContents(raw.contents);
  if (contents === null) return null;

  const range = RangeSchema.safeParse(raw.range);
  return range.success ? { contents, range: range.data } : { contents };
}

function normalizeDefinitionItem(raw: unknown): Location | null {
  const location = LocationSchema.safeParse(raw);
  if (location.success) return location.data;

  const locationLink = LocationLinkSchema.safeParse(raw);
  if (locationLink.success) {
    return {
      uri: locationLink.data.targetUri,
      range: locationLink.data.targetSelectionRange,
    };
  }

  return null;
}

function normalizeDefinitionResult(raw: unknown): unknown {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.flatMap((item) => {
    const normalized = normalizeDefinitionItem(item);
    return normalized ? [normalized] : [];
  });
}

function normalizeDocumentHighlightResult(raw: unknown): unknown {
  return raw ?? [];
}

function normalizeDocumentSymbolResult(raw: unknown): unknown {
  const parsed = z.array(DocumentSymbolSchema).safeParse(raw);
  if (parsed.success) return parsed.data;

  console.warn("[lsp-agent] textDocument/documentSymbol returned non-hierarchical symbols", {
    issues: parsed.error.issues,
  });
  return [];
}

function normalizeWorkspaceSymbolResult(raw: unknown): unknown {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [];
  return items.flatMap((item) => {
    const parsed = SymbolInformationSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function normalizeCompletionResult(raw: unknown): unknown {
  if (!raw) return [];
  const rawItems =
    Array.isArray(raw) || !isObjectLike(raw) ? raw : (raw as { items?: unknown }).items;
  const items = Array.isArray(rawItems) ? rawItems : [];
  return items.flatMap((item) => {
    const parsed = CompletionItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function parsePublishDiagnostics(
  params: unknown,
): { uri: string; diagnostics: z.infer<typeof DiagnosticSchema>[] } | null {
  const parsed = z
    .object({
      uri: TextDocumentIdentifierSchema.shape.uri,
      diagnostics: z.array(z.unknown()).optional(),
    })
    .safeParse(params);
  if (!parsed.success) return null;

  return {
    uri: parsed.data.uri,
    diagnostics: (parsed.data.diagnostics ?? []).flatMap((diagnostic) => {
      const item = DiagnosticSchema.safeParse(diagnostic);
      return item.success ? [item.data] : [];
    }),
  };
}

function parseAgentMessagePayload(payload: unknown): { serverId: string; message: unknown } | null {
  const record = asRecord(payload);
  if (!record || typeof record.serverId !== "string" || !("message" in record)) {
    return null;
  }
  return { serverId: record.serverId, message: record.message };
}

function parseAgentServerRequestPayload(
  payload: unknown,
): { serverId: string; agentRequestId: string; method: string; params: unknown } | null {
  const parsed = z
    .object({
      serverId: z.string(),
      agentRequestId: z.string(),
      method: z.string(),
      params: z.unknown().optional(),
    })
    .safeParse(payload);
  return parsed.success
    ? { ...parsed.data, params: parsed.data.params === undefined ? null : parsed.data.params }
    : null;
}

function firstShowMessageAction(params: unknown): unknown {
  const parsed = ShowMessageRequestParamsSchema.safeParse(params);
  if (!parsed.success) return null;
  return parsed.data.actions?.[0] ?? null;
}

function parseWorkDoneProgressCreateParams(params: unknown): unknown {
  const parsed = WorkDoneProgressCreateParamsSchema.safeParse(params);
  return parsed.success ? parsed.data : params;
}

function isPlainConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenInitializationOptions(
  value: unknown,
  prefix = "",
  output = new Map<string, unknown>(),
): Map<string, unknown> {
  if (!isPlainConfigObject(value)) {
    if (prefix.length > 0) output.set(prefix, value);
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    const childKey = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (isPlainConfigObject(child)) {
      flattenInitializationOptions(child, childKey, output);
    } else {
      output.set(childKey, child);
    }
  }
  return output;
}

function lookupFlattenedConfig(flatConfig: Map<string, unknown>, section: string): unknown {
  if (flatConfig.has(section)) return flatConfig.get(section);

  const prefix = `${section}.`;
  const sectionValue: Record<string, unknown> = {};
  let found = false;
  for (const [key, value] of flatConfig) {
    if (!key.startsWith(prefix)) continue;
    found = true;
    setNestedConfigValue(sectionValue, key.slice(prefix.length).split("."), value);
  }
  return found ? sectionValue : null;
}

function setNestedConfigValue(
  target: Record<string, unknown>,
  pathParts: string[],
  value: unknown,
) {
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    const existing = cursor[part];
    if (!isPlainConfigObject(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const leaf = pathParts.at(-1);
  if (leaf !== undefined) {
    cursor[leaf] = value;
  }
}

function lspError(raw: unknown): Error {
  if (isObjectLike(raw) && typeof raw.message === "string") {
    return new Error(raw.message);
  }
  return new Error("LSP error");
}

function abortError(): Error {
  const err = new Error("Request cancelled");
  err.name = "AbortError";
  return err;
}
