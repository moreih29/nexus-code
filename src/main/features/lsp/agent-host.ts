import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NumberSchema } from "../../../../packages/remote-protocol/src/validation";
import {
  AgentManifestSchema,
  findLspBinary,
  type LspBinaryManifestEntry,
} from "../../../shared/agent/manifest";
import { createLogger } from "../../../shared/log/main";
import {
  ApplyWorkspaceEditParamsSchema,
  CANONICAL_TOKEN_TYPES,
  type CompletionArgs,
  CompletionArgsSchema,
  CompletionItemSchema,
  type CompletionList,
  CompletionListSchema,
  CompletionResolveArgsSchema,
  CompletionTriggerKind,
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
  type SignatureHelpArgs,
  SignatureHelpArgsSchema,
  SignatureHelpSchema,
  SignatureHelpTriggerKind,
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
import type {
  LspLogEntry,
  LspLogLevel,
  LspServerMemory,
  LspServerStatus,
  LspStopReason,
} from "../../../shared/lsp/status";
import {
  LSP_COMPLETION_RESOLVE_TIMEOUT_MS,
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
  LSP_SIGNATURE_HELP_TIMEOUT_MS,
  LSP_WORKSPACE_SYMBOL_TIMEOUT_MS,
} from "../../../shared/util/timing-constants";
import type { AgentChannel } from "../../infra/agent/channel";
import { getAgentDistDir } from "../../infra/agent/getAgentBinDir";
import {
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
  parseFindBinaryResult,
  parseServerAssignedPayload,
  parseServerCapabilities,
  parseServerExitedPayload,
  parseSpawnResult,
  parseStatsResult,
  parseWorkDoneProgressCreateParams,
  serverExitError,
} from "./payloads";
import {
  normalizeCompletionItem,
  normalizeCompletionResult,
  normalizeDefinitionResult,
  normalizeDocumentHighlightResult,
  normalizeDocumentSymbolResult,
  normalizeHoverResult,
  normalizeSignatureHelpResult,
  normalizeWorkspaceSymbolResult,
  parsePublishDiagnostics,
} from "./result-normalizers";
import { LspServerStatusTracker } from "./server-status";
import { asRecord, isObjectLike } from "./utils";

const log = createLogger("lsp-agent");

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
  signal: AbortSignal;
}

interface ServerContext {
  workspaceId: string;
  languageId: string;
}

interface ServerStartup extends ServerContext {
  readonly controller: AbortController;
  readonly promise: Promise<AgentLspServer | null>;
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

const DidOpenArgsSchema = TextDocumentItemSchema.extend({
  workspaceId: z.string(),
  workspaceRoot: z.string(),
});

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

const STOP_REASON_TEXT: Record<LspStopReason, string> = {
  idle: "idle timeout",
  evicted: "evicted by LRU cap",
  off: "turned off",
  restart: "restarted",
  agent: "agent exited",
  crashed: "server exited",
};

const MESSAGE_LOG_LEVELS: Record<number, LspLogLevel> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "log",
  5: "log",
};

const LogMessageParamsSchema = z.object({ type: NumberSchema, message: z.string() });

const SERVER_EVENT_METHODS = new Set<string>([
  "window/logMessage",
  "window/showMessage",
  "window/showMessageRequest",
  "window/workDoneProgress/create",
  "$/progress",
]);

const REQUEST_TIMEOUT_MS: Record<string, number> = {
  hover: LSP_HOVER_TIMEOUT_MS,
  definition: LSP_DEFINITION_TIMEOUT_MS,
  completion: LSP_COMPLETION_TIMEOUT_MS,
  completionResolve: LSP_COMPLETION_RESOLVE_TIMEOUT_MS,
  signatureHelp: LSP_SIGNATURE_HELP_TIMEOUT_MS,
  references: LSP_REFERENCES_TIMEOUT_MS,
  documentHighlight: LSP_DOCUMENT_HIGHLIGHT_TIMEOUT_MS,
  documentSymbol: LSP_DOCUMENT_SYMBOL_TIMEOUT_MS,
  workspaceSymbol: LSP_WORKSPACE_SYMBOL_TIMEOUT_MS,
  semanticTokens: LSP_SEMANTIC_TOKENS_TIMEOUT_MS,
};

export class LspServerNotFoundError extends Error {
  constructor(
    readonly binary: string,
    userPath: string | undefined,
  ) {
    super(
      userPath
        ? `${binary} was found neither at ${userPath} nor on the PATH`
        : `${binary} was not found on the PATH or where its installer puts it`,
    );
    this.name = "LspServerNotFoundError";
  }
}

export class LspRequestTimeoutError extends Error {
  readonly kind = "lsp-request-timeout";
  constructor(method: string, timeoutMs: number) {
    super(`LSP request ${method} timed out after ${timeoutMs}ms`);
    this.name = "LspRequestTimeoutError";
  }
}

export interface AgentLspHostOptions {
  maxActiveWorkspaces?: number | (() => number);
  initializationOptions?: (languageId: string, preset: LspServerSpec) => unknown;
  serverPath?: (languageId: string) => string | undefined;
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
  private readonly channelKeys = new WeakMap<AgentChannel, number>();
  private nextChannelKey = 0;
  private readonly serverStartups = new Map<string, ServerStartup>();
  private readonly serverSpawnRequests = new Set<Promise<AgentLspServer | null>>();
  private readonly uriIndex = new Map<string, Map<string, string>>();
  private readonly configurationStore = new Map<string, Map<string, Map<string, unknown>>>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly channelDisposers = new Map<AgentChannel, Array<() => void>>();
  private readonly pendingSpawnByCorrelation = new Map<string, PendingSpawn>();
  private readonly pendingSpawnByServerId = new Map<string, PendingSpawn>();
  private readonly diagnosticsDebouncer = new DiagnosticsDebouncer({
    debounceMs: DIAGNOSTICS_DEBOUNCE_MS,
    leadingIdleMs: DIAGNOSTICS_LEADING_IDLE_MS,
    emit: (payload) => this.emit("diagnostics", payload),
  });
  private readonly workspaceLastActivity = new Map<string, number>();
  private readonly serverTimeoutCount = new Map<string, number>();
  private readonly serverSpawnedAt = new Map<string, number>();
  private readonly maxActiveWorkspaces: () => number;
  private readonly initializationOptionsFor: (languageId: string, preset: LspServerSpec) => unknown;
  private readonly serverPathFor: (languageId: string) => string | undefined;
  private readonly isLanguageEnabled: (workspaceId: string, languageId: string) => boolean;
  private readonly status = new LspServerStatusTracker((status) =>
    this.emit("serverStatus", status),
  );
  private nextServerRequestId = 1;
  private disposed = false;

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
    const maxActiveWorkspaces = options.maxActiveWorkspaces ?? LSP_MAX_ACTIVE_WORKSPACES;
    this.maxActiveWorkspaces =
      typeof maxActiveWorkspaces === "function" ? maxActiveWorkspaces : () => maxActiveWorkspaces;
    this.initializationOptionsFor =
      options.initializationOptions ?? ((_languageId, preset) => preset.initializationOptions);
    this.serverPathFor = options.serverPath ?? (() => undefined);
    this.isLanguageEnabled = options.isLanguageEnabled ?? (() => true);
  }

  async call(method: string, args: unknown, opts: LspHostCallOptions = {}): Promise<unknown> {
    if (this.disposed) {
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
        return this.completion(args, opts);
      case "completionResolve":
        return this.completionResolve(args, opts);
      case "signatureHelp":
        return this.signatureHelp(args, opts);
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.diagnosticsDebouncer.clearAll();
    for (const startup of this.serverStartups.values()) startup.controller.abort();
    this.serverStartups.clear();
    const shutdowns = Array.from(this.serversById.values(), (server) => server.dispose());
    this.serversById.clear();
    this.workspaceServers.clear();
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
    await Promise.allSettled([...shutdowns, ...this.serverSpawnRequests]);
  }

  disposeLanguage(
    workspaceId: string,
    languageId: string,
    reason: LspStopReason,
    options: { reopen?: boolean } = {},
  ): void {
    this.disposeServers((w, l) => w === workspaceId && l === languageId, reason, options);
  }

  disposeServers(
    matches: (workspaceId: string, languageId: string) => boolean,
    reason: LspStopReason,
    options: { reopen?: boolean } = {},
  ): void {
    if (this.disposed) return;
    if (reason === "off") {
      for (const [key, { workspaceId, languageId, controller }] of this.serverStartups) {
        if (!matches(workspaceId, languageId)) continue;
        controller.abort();
        this.serverStartups.delete(key);
        if (this.workspaceServers.get(workspaceId)?.has(languageId)) continue;
        this.status.stopped(workspaceId, languageId, reason, STOP_REASON_TEXT[reason]);
        this.emit("workspaceLspReset", {
          workspaceId,
          languageId,
          reason: STOP_REASON_TEXT[reason],
        });
      }
    }
    for (const [workspaceId, servers] of Array.from(this.workspaceServers)) {
      for (const languageId of Array.from(servers.keys())) {
        if (matches(workspaceId, languageId)) {
          this.disposeWorkspaceServers(workspaceId, reason, { languageId, reopen: options.reopen });
        }
      }
    }
    for (const { workspaceId, languageId } of this.status.givenUp()) {
      if (!matches(workspaceId, languageId)) continue;
      this.status.resetFailures(workspaceId, languageId, reason);
      if (options.reopen) {
        this.emit("workspaceLspReset", {
          workspaceId,
          languageId,
          reason: STOP_REASON_TEXT[reason],
          reopen: true,
        });
      }
    }
  }

  restartLanguage(workspaceId: string, languageId: string): void {
    if (this.disposed) return;
    if (this.workspaceServers.get(workspaceId)?.has(languageId)) {
      this.disposeLanguage(workspaceId, languageId, "restart", { reopen: true });
      return;
    }
    this.status.resetFailures(workspaceId, languageId, "restart");
    this.emit("workspaceLspReset", {
      workspaceId,
      languageId,
      reason: STOP_REASON_TEXT.restart,
      reopen: true,
    });
  }

  enforceMaxActiveWorkspaces(): void {
    if (this.disposed) return;
    while (this.workspaceServers.size > this.maxActiveWorkspaces()) {
      const lru = this.leastRecentlyUsedWorkspace(null);
      if (!lru) return;
      this.disposeWorkspaceServers(lru, "evicted");
    }
  }

  serverStatuses(): LspServerStatus[] {
    return this.status.list();
  }

  serverLog(workspaceId: string, languageId: string, afterSeq?: number): LspLogEntry[] {
    return this.status.logEntries(workspaceId, languageId, afterSeq);
  }

  async serverMemory(workspaceId: string): Promise<LspServerMemory[]> {
    const byChannel = new Map<AgentChannel, AgentLspServer[]>();
    for (const server of this.workspaceServers.get(workspaceId)?.values() ?? []) {
      byChannel.set(server.channel, [...(byChannel.get(server.channel) ?? []), server]);
    }
    const results = await Promise.all(
      Array.from(byChannel, async ([channel, servers]) => {
        try {
          const stats = parseStatsResult(await channel.call("lsp.stats", {}));
          return servers.flatMap((server) => {
            const entry = stats.find((s) => s.serverId === server.serverId);
            return entry ? [{ languageId: server.languageId, rssBytes: entry.rssBytes }] : [];
          });
        } catch (error) {
          log.warn(`lsp.stats failed: ${(error as Error).message}`);
          return [];
        }
      }),
    );
    return results.flat();
  }

  forgetWorkspace(workspaceId: string): void {
    this.status.forgetWorkspace(workspaceId);
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

  private async completion(args: unknown, opts: LspHostCallOptions): Promise<unknown> {
    const parsed = CompletionArgsSchema.parse(args);
    if (
      parsed.triggerKind === CompletionTriggerKind.TriggerCharacter &&
      parsed.triggerCharacter !== undefined
    ) {
      const routed = this.findServer(parsed.workspaceId, parsed.uri);
      if (routed && !completionTriggerCharacters(routed.server).includes(parsed.triggerCharacter)) {
        return EMPTY_COMPLETION_LIST;
      }
    }
    return this.requestByUri(
      parsed,
      opts,
      {
        argsSchema: CompletionArgsSchema,
        lspMethod: "textDocument/completion",
        capabilityKey: "completionProvider",
        emptyResponse: EMPTY_COMPLETION_LIST,
        outSchema: CompletionListSchema,
        params: completionParams,
        transform: normalizeCompletionResult,
      },
      "completion",
    );
  }

  private async completionResolve(args: unknown, opts: LspHostCallOptions): Promise<unknown> {
    const parsed = CompletionResolveArgsSchema.parse(args);
    const routed = this.findServer(parsed.workspaceId, parsed.uri);
    if (!routed?.server.hasCapability("completionProvider", "resolveProvider")) return parsed.item;
    this.touchWorkspace(parsed.workspaceId);

    let raw: unknown;
    try {
      raw = await withRequestTimeout(
        (signal) => routed.server.request("completionItem/resolve", parsed.item, { signal }),
        opts.signal,
        "completionResolve",
      );
    } catch (error) {
      if (error instanceof LspRequestTimeoutError) {
        this.trackTimeout(routed.context.workspaceId, routed.context.languageId);
      }
      throw error;
    }
    this.resetTimeoutCount(routed.context.workspaceId, routed.context.languageId);
    return CompletionItemSchema.parse(normalizeCompletionItem(raw) ?? parsed.item);
  }

  private async signatureHelp(args: unknown, opts: LspHostCallOptions): Promise<unknown> {
    const parsed = SignatureHelpArgsSchema.parse(args);
    if (
      parsed.triggerKind === SignatureHelpTriggerKind.TriggerCharacter &&
      parsed.triggerCharacter !== undefined &&
      !parsed.isRetrigger
    ) {
      const routed = this.findServer(parsed.workspaceId, parsed.uri);
      if (
        routed &&
        !signatureHelpTriggerCharacters(routed.server).includes(parsed.triggerCharacter)
      ) {
        return null;
      }
    }
    return this.requestByUri(
      parsed,
      opts,
      {
        argsSchema: SignatureHelpArgsSchema,
        lspMethod: "textDocument/signatureHelp",
        capabilityKey: "signatureHelpProvider",
        emptyResponse: null,
        outSchema: SignatureHelpSchema.nullable(),
        params: signatureHelpParams,
        transform: normalizeSignatureHelpResult,
      },
      "signatureHelp",
    );
  }

  private async semanticTokensByUri(args: unknown, opts: LspHostCallOptions): Promise<unknown> {
    const parsed = SemanticTokensArgsSchema.parse(args);
    const routed = this.findServer(parsed.workspaceId, parsed.uri);
    if (!routed) return null;
    if (!routed.server.hasCapability("semanticTokensProvider")) return null;
    this.touchWorkspace(parsed.workspaceId);

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
        log.warn(
          `workspace/symbol request failed: ${(item.reason as Error)?.message ?? String(item.reason)}`,
        );
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

    if (!this.isLanguageEnabled(workspaceId, presetLanguageId)) return null;
    if (this.status.hasGivenUp(workspaceId, presetLanguageId)) return null;

    const existing = this.workspaceServers.get(workspaceId)?.get(presetLanguageId);
    if (existing) return existing;

    const key = `${workspaceId}\0${presetLanguageId}`;
    const pending = this.serverStartups.get(key);
    if (pending) return pending.promise;

    this.evictLruWorkspaceIfNeeded(workspaceId);

    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() =>
        this.spawnServer(workspaceId, presetLanguageId, workspaceRoot, preset, controller.signal),
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted) return null;
        this.handleSpawnFailure(workspaceId, presetLanguageId, error);
        throw error;
      })
      .finally(() => {
        if (this.serverStartups.get(key)?.controller === controller)
          this.serverStartups.delete(key);
      });
    this.serverStartups.set(key, {
      workspaceId,
      languageId: presetLanguageId,
      controller,
      promise,
    });
    return promise;
  }

  private handleSpawnFailure(workspaceId: string, languageId: string, error: unknown): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    const retry = this.status.failed(workspaceId, languageId, `Failed to start: ${message}`, {
      didNotStart: true,
      ...(error instanceof LspServerNotFoundError ? { missingBinary: error.binary } : {}),
    });
    this.emit("workspaceLspReset", {
      workspaceId,
      languageId,
      reason: "failed to start",
      ...(retry ? { reopen: true } : {}),
    });
  }

  private touchWorkspace(workspaceId: string): void {
    this.workspaceLastActivity.set(workspaceId, Date.now());
  }

  private evictLruWorkspaceIfNeeded(activeWorkspaceId: string): void {
    if (this.workspaceServers.has(activeWorkspaceId)) return;
    while (this.workspaceServers.size >= this.maxActiveWorkspaces()) {
      const lru = this.leastRecentlyUsedWorkspace(activeWorkspaceId);
      if (!lru) return;
      this.disposeWorkspaceServers(lru, "evicted");
    }
  }

  private leastRecentlyUsedWorkspace(exceptWorkspaceId: string | null): string | null {
    let lruWorkspaceId: string | null = null;
    let lruTime = Number.POSITIVE_INFINITY;
    for (const wsId of this.workspaceServers.keys()) {
      if (wsId === exceptWorkspaceId) continue;
      const t = this.workspaceLastActivity.get(wsId) ?? 0;
      if (t < lruTime) {
        lruTime = t;
        lruWorkspaceId = wsId;
      }
    }
    return lruWorkspaceId;
  }

  private disposeWorkspaceServers(
    workspaceId: string,
    stop: LspStopReason,
    options?: {
      languageId?: string;
      reopen?: boolean;
      updateStatus?: boolean;
    },
  ): void {
    const servers = this.workspaceServers.get(workspaceId);
    if (!servers) return;

    const reason = STOP_REASON_TEXT[stop];
    const targetLanguageId = options?.languageId;
    if (options?.updateStatus !== false) {
      for (const languageId of servers.keys()) {
        if (!targetLanguageId || languageId === targetLanguageId) {
          this.status.stopped(workspaceId, languageId, stop, reason);
        }
      }
    }

    if (targetLanguageId) {
      const server = servers.get(targetLanguageId);
      if (!server) return;
      this.diagnosticsDebouncer.clearForServer(server.workspaceId, server.languageId);
      this.dropUriOwnershipForServer(server.workspaceId, server.languageId);
      this.serversById.delete(this.serverIdKey(server.channel, server.serverId));
      server.dispose();
      servers.delete(targetLanguageId);
      const serverKey = `${workspaceId}\0${targetLanguageId}`;
      this.serverTimeoutCount.delete(serverKey);
      this.serverSpawnedAt.delete(serverKey);
      if (servers.size === 0) {
        this.workspaceServers.delete(workspaceId);
        this.workspaceLastActivity.delete(workspaceId);
      }
      this.emit("workspaceLspReset", {
        workspaceId,
        languageId: targetLanguageId,
        reason,
        ...(options?.reopen ? { reopen: true } : {}),
      });
    } else {
      for (const server of servers.values()) {
        this.diagnosticsDebouncer.clearForServer(server.workspaceId, server.languageId);
        this.dropUriOwnershipForServer(server.workspaceId, server.languageId);
        this.serversById.delete(this.serverIdKey(server.channel, server.serverId));
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
    signal: AbortSignal,
  ): Promise<AgentLspServer | null> {
    if (signal.aborted) return null;
    this.status.starting(workspaceId, presetLanguageId);
    const channel = await this.workspaceManager.getAgentChannel(workspaceId);
    await channel.ready;
    if (signal.aborted) return null;

    const command = preset.system
      ? await this.findSystemServer(channel, presetLanguageId, workspaceRoot, preset)
      : await this.resolveServerCommand(workspaceId, presetLanguageId, preset);
    if (signal.aborted) return null;

    this.subscribeChannel(channel);
    const initializationOptions = this.initializationOptionsFor(presetLanguageId, preset);
    this.storeInitializationOptions(workspaceId, presetLanguageId, initializationOptions);

    const correlationId = randomUUID();
    const pendingSpawn: PendingSpawn = {
      channel,
      workspaceId,
      languageId: presetLanguageId,
      correlationId,
      signal,
    };
    this.pendingSpawnByCorrelation.set(correlationId, pendingSpawn);

    let serverId: string | undefined;
    const request = channel
      .call<AgentSpawnResult>("lsp.spawn", {
        workspaceId,
        languageId: presetLanguageId,
        binaryPath: command.binaryPath,
        args: [...command.args],
        ...(command.env ? { env: command.env } : {}),
        workspaceRoot,
        idleTimeoutMs: LSP_DEFAULT_IDLE_MS,
        correlationId,
        capabilities: LSP_CLIENT_CAPABILITIES,
        ...(initializationOptions !== undefined ? { initializationOptions } : {}),
      })
      .then(async (result) => {
        const spawned = parseSpawnResult(result);
        serverId = spawned.serverId;
        const server = new AgentLspServer({
          channel,
          serverId,
          workspaceId,
          languageId: presetLanguageId,
          capabilities: parseServerCapabilities(result.capabilities),
        });
        if (signal.aborted) {
          await server.dispose();
          return null;
        }
        this.rememberServer(server);
        this.status.running(
          workspaceId,
          presetLanguageId,
          spawned.serverInfo ?? (preset.system ? undefined : bundledServerInfo(preset)),
        );
        return server;
      });
    this.serverSpawnRequests.add(request);
    try {
      return await request;
    } finally {
      this.serverSpawnRequests.delete(request);
      this.pendingSpawnByCorrelation.delete(correlationId);
      if (serverId) this.pendingSpawnByServerId.delete(this.serverIdKey(channel, serverId));
    }
  }

  private async findSystemServer(
    channel: AgentChannel,
    languageId: string,
    workspaceRoot: string,
    preset: LspServerSpec,
  ): Promise<LspServerCommand> {
    const userPath = this.serverPathFor(languageId);
    const found = parseFindBinaryResult(
      await channel.call("lsp.findBinary", {
        name: preset.binary,
        ...(userPath ? { path: userPath } : {}),
        dir: workspaceRoot,
      }),
    );
    if (!found.path) throw new LspServerNotFoundError(preset.binary, userPath);
    return {
      binaryPath: found.path,
      args: preset.args,
      ...(found.envPath ? { env: { PATH: found.envPath } } : {}),
    };
  }

  private async resolveServerCommand(
    workspaceId: string,
    languageId: string,
    preset: LspServerSpec,
  ): Promise<LspServerCommand> {
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
    this.serversById.set(this.serverIdKey(server.channel, server.serverId), server);
    const serverKey = `${server.workspaceId}\0${server.languageId}`;
    this.serverSpawnedAt.set(serverKey, Date.now());
    this.serverTimeoutCount.delete(serverKey);
  }

  private findServer(
    workspaceId: string,
    uri: string,
  ): { server: AgentLspServer; context: ServerContext } | null {
    const presetLanguageId = this.uriIndex.get(workspaceId)?.get(uri);
    if (!presetLanguageId) return null;
    const server = this.workspaceServers.get(workspaceId)?.get(presetLanguageId);
    return server ? { server, context: { workspaceId, languageId: presetLanguageId } } : null;
  }

  private recordUriOwnership(workspaceId: string, uri: string, presetLanguageId: string): void {
    let workspaceMap = this.uriIndex.get(workspaceId);
    if (!workspaceMap) {
      workspaceMap = new Map();
      this.uriIndex.set(workspaceId, workspaceMap);
    }
    workspaceMap.set(uri, presetLanguageId);
  }

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
      this.handleServerAssigned(channel, payload);
    });
    const offServerExited = channel.on("lsp.serverExited", (payload) => {
      this.handleServerExited(channel, payload);
    });
    const offLifecycle = channel.onLifecycle((event) => {
      if (event.type === "exit" || event.type === "failure" || event.type === "disposed") {
        this.disposeChannelServers(channel, "agent exited");
        this.unsubscribeChannel(channel);
      } else if (event.type === "held-then-expired") {
        this.disposeChannelServers(channel, "agent replaced");
      } else if (event.type === "reconnecting" && !event.hadEpoch) {
        this.disposeChannelServers(channel, "agent restarted");
      }
    });
    this.channelDisposers.set(channel, [
      offMessage,
      offServerRequest,
      offServerAssigned,
      offServerExited,
      offLifecycle,
    ]);
  }

  private unsubscribeChannel(channel: AgentChannel): void {
    const disposers = this.channelDisposers.get(channel);
    if (!disposers) return;
    this.channelDisposers.delete(channel);
    for (const dispose of disposers) dispose();
  }

  private serverIdKey(channel: AgentChannel, serverId: string): string {
    let channelKey = this.channelKeys.get(channel);
    if (channelKey === undefined) {
      channelKey = this.nextChannelKey++;
      this.channelKeys.set(channel, channelKey);
    }
    return `${channelKey}\0${serverId}`;
  }

  private handleServerAssigned(channel: AgentChannel, payload: unknown): void {
    const parsed = parseServerAssignedPayload(payload);
    if (!parsed?.correlationId) return;

    const pending = this.pendingSpawnByCorrelation.get(parsed.correlationId);
    if (!pending || pending.channel !== channel || pending.signal.aborted) return;
    this.pendingSpawnByServerId.set(this.serverIdKey(channel, parsed.serverId), pending);
  }

  private handleServerExited(channel: AgentChannel, payload: unknown): void {
    const parsed = parseServerExitedPayload(payload);
    if (!parsed) return;

    const key = this.serverIdKey(channel, parsed.serverId);
    const server = this.serversById.get(key);
    if (server) {
      this.diagnosticsDebouncer.clearForServer(server.workspaceId, server.languageId);

      server.disposePending(serverExitError(parsed));
      this.serversById.delete(key);
      const servers = this.workspaceServers.get(server.workspaceId);
      if (servers?.get(server.languageId) === server) servers.delete(server.languageId);
      if (servers?.size === 0) {
        this.workspaceServers.delete(server.workspaceId);
        this.workspaceLastActivity.delete(server.workspaceId);
      }
      this.dropUriOwnershipForServer(server.workspaceId, server.languageId);

      const serverKey = `${server.workspaceId}\0${server.languageId}`;
      this.serverTimeoutCount.delete(serverKey);
      this.serverSpawnedAt.delete(serverKey);

      if (parsed.stderrTail.trim()) {
        this.status.log(server.workspaceId, server.languageId, "stderr", parsed.stderrTail);
      }
      let reopen = false;
      if (parsed.shutdown) {
        this.status.stopped(server.workspaceId, server.languageId, "idle", STOP_REASON_TEXT.idle);
      } else {
        const how = parsed.reason ? `: ${parsed.reason}` : "";
        reopen = this.status.failed(
          server.workspaceId,
          server.languageId,
          `Exited unexpectedly${how}`,
        );
      }

      this.emit("workspaceLspReset", {
        workspaceId: server.workspaceId,
        languageId: server.languageId,
        reason: parsed.reason || "server exited",
        ...(reopen ? { reopen: true } : {}),
      });
    } else {
      const pending = this.pendingSpawnByServerId.get(key);
      if (pending && !pending.signal.aborted && parsed.stderrTail.trim()) {
        this.status.log(pending.workspaceId, pending.languageId, "stderr", parsed.stderrTail);
      }
    }

    for (const [id, pending] of this.pendingServerRequests) {
      if (pending.channel === channel && pending.serverId === parsed.serverId) {
        this.pendingServerRequests.delete(id);
      }
    }
    this.pendingSpawnByServerId.delete(key);
  }

  private disposeChannelServers(channel: AgentChannel, reason: string): void {
    for (const server of Array.from(this.serversById.values())) {
      if (server.channel !== channel) continue;
      this.diagnosticsDebouncer.clearForServer(server.workspaceId, server.languageId);
      server.disposePending(new Error(`LSP server lost: ${reason}`));
      this.serversById.delete(this.serverIdKey(server.channel, server.serverId));
      const servers = this.workspaceServers.get(server.workspaceId);
      if (servers?.get(server.languageId) === server) servers.delete(server.languageId);
      if (servers?.size === 0) {
        this.workspaceServers.delete(server.workspaceId);
        this.workspaceLastActivity.delete(server.workspaceId);
      }
      this.dropUriOwnershipForServer(server.workspaceId, server.languageId);
      const serverKey = `${server.workspaceId}\0${server.languageId}`;
      this.serverTimeoutCount.delete(serverKey);
      this.serverSpawnedAt.delete(serverKey);
      this.status.stopped(server.workspaceId, server.languageId, "agent", reason);
      this.emit("workspaceLspReset", {
        workspaceId: server.workspaceId,
        languageId: server.languageId,
        reason,
      });
    }
    for (const [id, pending] of this.pendingServerRequests) {
      if (pending.channel === channel) this.pendingServerRequests.delete(id);
    }
  }

  private handleAgentMessage(channel: AgentChannel, payload: unknown): void {
    const parsed = parseAgentMessagePayload(payload);
    if (!parsed) return;

    const server = this.serversById.get(this.serverIdKey(channel, parsed.serverId));
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
        this.emitApplyEditRequest(channel, context, parsed);
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
    context: ServerContext,
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
    this.emit("serverRequest", {
      id,
      workspaceId: context.workspaceId,
      method: request.method,
      params: parsed.data,
    });
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
      log.warn(`failed to respond to server request: ${(error as Error).message}`);
    }
  }

  private handleServerNotification(context: ServerContext, message: unknown): void {
    const msg = asRecord(message);
    if (!msg || typeof msg.method !== "string" || "id" in msg) return;

    if (msg.method === "textDocument/publishDiagnostics") {
      const parsed = parsePublishDiagnostics(msg.params);
      if (parsed) {
        this.diagnosticsDebouncer.schedule({
          workspaceId: context.workspaceId,
          languageId: context.languageId,
          uri: parsed.uri,
          diagnostics: parsed.diagnostics,
        });
      }
      return;
    }

    if (msg.method === "window/logMessage" || msg.method === "window/showMessage") {
      const parsed = LogMessageParamsSchema.safeParse(msg.params);
      if (parsed.success) {
        const level = MESSAGE_LOG_LEVELS[parsed.data.type] ?? "log";
        this.status.log(context.workspaceId, context.languageId, level, parsed.data.message);
      }
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
    const key = this.serverIdKey(channel, serverId);
    const server = this.serversById.get(key);
    if (server) {
      return { workspaceId: server.workspaceId, languageId: server.languageId };
    }
    const pending = this.pendingSpawnByServerId.get(key);
    return pending && !pending.signal.aborted
      ? { workspaceId: pending.workspaceId, languageId: pending.languageId }
      : null;
  }

  private dropUriOwnershipForServer(workspaceId: string, presetLanguageId: string): void {
    const workspaceMap = this.uriIndex.get(workspaceId);
    if (!workspaceMap) return;
    for (const [uri, owningPreset] of workspaceMap) {
      if (owningPreset === presetLanguageId) workspaceMap.delete(uri);
    }
    if (workspaceMap.size === 0) this.uriIndex.delete(workspaceId);
  }

  private trackTimeout(workspaceId: string, languageId: string): void {
    const serverKey = `${workspaceId}\0${languageId}`;
    const spawnedAt = this.serverSpawnedAt.get(serverKey);
    if (spawnedAt !== undefined && Date.now() - spawnedAt < LSP_SERVER_WEDGE_GRACE_MS) {
      return;
    }
    const count = (this.serverTimeoutCount.get(serverKey) ?? 0) + 1;
    if (count >= LSP_CONSECUTIVE_TIMEOUT_LIMIT) {
      this.serverTimeoutCount.delete(serverKey);
      log.warn(
        `${workspaceId}/${languageId} wedged (${LSP_CONSECUTIVE_TIMEOUT_LIMIT} consecutive timeouts) — restarting`,
      );
      const retry = this.status.failed(
        workspaceId,
        languageId,
        `Stopped answering: ${LSP_CONSECUTIVE_TIMEOUT_LIMIT} requests in a row timed out`,
      );
      this.disposeWorkspaceServers(workspaceId, "crashed", {
        languageId,
        reopen: retry,
        updateStatus: false,
      });
    } else {
      this.serverTimeoutCount.set(serverKey, count);
    }
  }

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
  outSchema: z.ZodType;
  params: (args: A) => unknown;
  transform?: (raw: unknown) => unknown;
}

async function withRequestTimeout<T>(
  exec: (signal: AbortSignal) => Promise<T>,
  externalSignal: AbortSignal | undefined,
  methodName: string,
): Promise<T> {
  const timeoutMs = REQUEST_TIMEOUT_MS[methodName];
  if (timeoutMs === undefined) {
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

interface LspServerCommand {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

function resolveLocalLspCommand(preset: LspServerSpec): LspServerCommand {
  const fromManifest = resolveLspCommandFromManifest(preset);
  if (fromManifest) return fromManifest;
  return { binaryPath: resolveDevBundledBinary(preset.binary), args: preset.args };
}

export function resolveLspCommandFromManifest(
  preset: LspServerSpec,
  distDir = getAgentDistDir(),
): LspServerCommand | null {
  const lsp = findBundledLsp(preset, distDir);
  if (!lsp) return null;
  const extractedDir = path.join(distDir, "lsp", `${lsp.name}-${lsp.version}`);
  const entry = path.join(extractedDir, lsp.entry);
  if (!fs.existsSync(entry)) return null;
  return {
    binaryPath: process.execPath,
    args: [entry, ...preset.args],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function bundledServerInfo(
  preset: LspServerSpec,
  distDir = getAgentDistDir(),
): { name: string; version: string } | undefined {
  const lsp = findBundledLsp(preset, distDir);
  return lsp ? { name: lsp.packageName, version: lsp.version } : undefined;
}

function findBundledLsp(preset: LspServerSpec, distDir: string): LspBinaryManifestEntry | null {
  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = AgentManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    return findLspBinary(manifest, { name: preset.binary }) ?? null;
  } catch {
    return null;
  }
}

function resolveDevBundledBinary(binary: string): string {
  const bundledPath = path.resolve(__dirname, "../../../node_modules/.bin", binary);
  if (fs.existsSync(bundledPath)) return bundledPath;
  return path.resolve(process.cwd(), "node_modules/.bin", binary);
}

function textDocumentPositionParams(args: { uri: string; line: number; character: number }) {
  return {
    textDocument: { uri: args.uri },
    position: { line: args.line, character: args.character },
  };
}

const EMPTY_COMPLETION_LIST: CompletionList = { isIncomplete: false, items: [] };

function completionParams(args: CompletionArgs) {
  if (args.triggerKind === undefined) return textDocumentPositionParams(args);
  return {
    ...textDocumentPositionParams(args),
    context: {
      triggerKind: args.triggerKind,
      ...(args.triggerKind === CompletionTriggerKind.TriggerCharacter
        ? { triggerCharacter: args.triggerCharacter }
        : {}),
    },
  };
}

function completionTriggerCharacters(server: AgentLspServer): string[] {
  const provider = server.getCapabilityValue("completionProvider");
  if (!isObjectLike(provider) || !Array.isArray(provider.triggerCharacters)) return [];
  return provider.triggerCharacters.filter((c): c is string => typeof c === "string");
}

function signatureHelpParams(args: SignatureHelpArgs) {
  return {
    ...textDocumentPositionParams(args),
    context: {
      triggerKind: args.triggerKind,
      ...(args.triggerCharacter !== undefined ? { triggerCharacter: args.triggerCharacter } : {}),
      isRetrigger: args.isRetrigger,
      ...(args.activeSignatureHelp ? { activeSignatureHelp: args.activeSignatureHelp } : {}),
    },
  };
}

function signatureHelpTriggerCharacters(server: AgentLspServer): string[] {
  const provider = server.getCapabilityValue("signatureHelpProvider");
  if (!isObjectLike(provider) || !Array.isArray(provider.triggerCharacters)) return [];
  return provider.triggerCharacters.filter((c): c is string => typeof c === "string");
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

function extractServerTokenTypes(capabilityValue: unknown): string[] {
  if (!capabilityValue || typeof capabilityValue !== "object") return [];
  const cap = capabilityValue as Record<string, unknown>;
  const legend = cap.legend;
  if (!legend || typeof legend !== "object") return [];
  const tokenTypes = (legend as Record<string, unknown>).tokenTypes;
  if (!Array.isArray(tokenTypes)) return [];
  return tokenTypes.filter((t): t is string => typeof t === "string");
}
