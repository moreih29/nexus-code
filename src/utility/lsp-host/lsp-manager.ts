// LSP manager — owns language server adapter instances per workspace/language.
// Runs inside the lsp-host utility process; communicates with the main process
// via MessagePort set up by lspHost.ts in the main process.
//
// Lifecycle: lazy spawn on first didOpen, 30-minute idle graceful shutdown.

import path from "node:path";
import { z } from "zod";
import { absolutePathToFileUri } from "../../shared/file-uri";
import {
  type LspServerSpec,
  resolveLspPreset,
  resolveLspPresetLanguageId,
} from "../../shared/lsp-config";
import {
  ApplyWorkspaceEditParamsSchema,
  type ApplyWorkspaceEditResult,
  ApplyWorkspaceEditResultSchema,
  CompletionItemSchema,
  ConfigurationParamsSchema,
  type Diagnostic,
  DiagnosticSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  FileChangeType,
  type FileEvent,
  HoverResultSchema,
  type Location,
  LocationLinkSchema,
  LocationSchema,
  type LspServerEventMethod,
  MarkupContentSchema,
  RangeSchema,
  ReferencesArgsSchema,
  type Registration,
  RegistrationParamsSchema,
  ShowMessageRequestParamsSchema,
  SymbolInformationSchema,
  TextDocumentContentChangeEventSchema,
  TextDocumentIdentifierSchema,
  TextDocumentItemSchema,
  TextDocumentPositionArgsSchema,
  WorkDoneProgressCreateParamsSchema,
  WorkspaceSymbolArgsSchema,
} from "../../shared/lsp-types";
import { LSP_DEFAULT_IDLE_MS } from "../../shared/timing-constants";
import { FsChangeKindSchema } from "../../shared/types/fs";
import { type LspAdapter, StdioLspAdapter } from "./servers/stdio-lsp-adapter";

// Inbound message shapes (main → utility)
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
// Handler metadata
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

const FsChangedArgsSchema = z.object({
  workspaceId: z.string(),
  changes: z.array(
    z.object({
      relPath: z.string(),
      kind: FsChangeKindSchema,
    }),
  ),
});

const VoidResultSchema = z.null();
const PublishDiagnosticsParamsSchema = z.object({
  uri: TextDocumentIdentifierSchema.shape.uri,
  diagnostics: z.array(z.unknown()).optional(),
});

const WATCHED_FILES_METHOD = "workspace/didChangeWatchedFiles";
const MAIN_SERVER_REQUEST_TIMEOUT_MS = 10_000;

interface RoutedAdapter {
  workspaceId: string;
  languageId: string;
  adapter: LspAdapter;
}

interface HandlerMeta {
  kind: "request" | "notify";
  lspMethod: string;
  capabilityKey?: string;
  inSchema: z.ZodTypeAny;
  outSchema: z.ZodTypeAny;
  emptyResponse: unknown;
  route: (
    manager: LspManager,
    args: unknown,
  ) => Promise<RoutedAdapter | RoutedAdapter[] | undefined>;
  params: (args: unknown) => unknown;
  transform?: (result: unknown) => unknown;
  invoke?: (
    adapter: LspAdapter,
    lspMethod: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown> | unknown;
  after?: (manager: LspManager, args: unknown, routed: RoutedAdapter) => void;
}

interface HandlerMetaInput<S extends z.ZodTypeAny> {
  kind: HandlerMeta["kind"];
  lspMethod: string;
  capabilityKey?: string;
  inSchema: S;
  outSchema: z.ZodTypeAny;
  emptyResponse: unknown;
  route:
    | ((
        manager: LspManager,
        args: z.infer<S>,
      ) => Promise<RoutedAdapter | RoutedAdapter[] | undefined>)
    | ((manager: LspManager, args: z.infer<S>) => RoutedAdapter | RoutedAdapter[] | undefined);
  params: (args: z.infer<S>) => unknown;
  transform?: (result: unknown) => unknown;
  invoke?: (
    adapter: LspAdapter,
    lspMethod: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown> | unknown;
  after?: (manager: LspManager, args: z.infer<S>, routed: RoutedAdapter) => void;
}

function defineHandler<S extends z.ZodTypeAny>(input: HandlerMetaInput<S>): HandlerMeta {
  return {
    kind: input.kind,
    lspMethod: input.lspMethod,
    capabilityKey: input.capabilityKey,
    inSchema: input.inSchema,
    outSchema: input.outSchema,
    emptyResponse: input.emptyResponse,
    route: (manager, args) => Promise.resolve(input.route(manager, args as z.infer<S>)),
    params: (args) => input.params(args as z.infer<S>),
    transform: input.transform,
    invoke: input.invoke,
    after: input.after
      ? (manager, args, routed) => input.after?.(manager, args as z.infer<S>, routed)
      : undefined,
  };
}

function routeByUri(manager: LspManager, args: { uri: string }): RoutedAdapter | undefined {
  return manager.findAdapterForUri(args.uri);
}

function routeWorkspaceAdapters(
  manager: LspManager,
  args: z.infer<typeof WorkspaceSymbolArgsSchema>,
): RoutedAdapter[] {
  const workspaceAdapters = manager.adapters.get(args.workspaceId);
  if (!workspaceAdapters) return [];
  return Array.from(workspaceAdapters, ([languageId, adapter]) => ({
    workspaceId: args.workspaceId,
    languageId,
    adapter,
  }));
}

async function routeOpenedDocument(
  manager: LspManager,
  args: z.infer<typeof DidOpenArgsSchema>,
): Promise<RoutedAdapter | undefined> {
  const presetLanguageId = resolveLspPresetLanguageId(args.languageId);
  if (!presetLanguageId) return undefined;

  const adapter = await manager.getOrCreateAdapter(
    args.workspaceId,
    args.languageId,
    args.workspaceRoot,
  );
  return adapter
    ? { workspaceId: args.workspaceId, languageId: presetLanguageId, adapter }
    : undefined;
}

function textDocumentPositionParams(args: z.infer<typeof TextDocumentPositionArgsSchema>): {
  textDocument: { uri: string };
  position: { line: number; character: number };
} {
  return {
    textDocument: { uri: args.uri },
    position: { line: args.line, character: args.character },
  };
}

function referencesParams(args: z.infer<typeof ReferencesArgsSchema>): unknown {
  return {
    ...textDocumentPositionParams(args),
    context: { includeDeclaration: args.includeDeclaration },
  };
}

function documentSymbolParams(args: z.infer<typeof TextDocumentIdentifierSchema>): unknown {
  return { textDocument: { uri: args.uri } };
}

function markedStringToMarkdown(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null || !("value" in raw)) return "";

  const value = (raw as { value?: unknown }).value;
  if (typeof value !== "string") return "";

  const language = (raw as { language?: unknown }).language;
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
  if (typeof raw !== "object" || raw === null) return null;
  const result = raw as { contents?: unknown; range?: unknown };
  const contents = normalizeHoverContents(result.contents);
  if (contents === null) return null;

  const range = RangeSchema.safeParse(result.range);
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

  console.warn("[lsp-manager] textDocument/documentSymbol returned non-hierarchical symbols", {
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
    Array.isArray(raw) || typeof raw !== "object" || raw === null
      ? raw
      : (raw as { items?: unknown }).items;
  const items = Array.isArray(rawItems) ? rawItems : [];
  return items.flatMap((item) => {
    const parsed = CompletionItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function parsePublishDiagnostics(
  params: unknown,
): { uri: string; diagnostics: Diagnostic[] } | null {
  const parsed = PublishDiagnosticsParamsSchema.safeParse(params);
  if (!parsed.success) return null;

  return {
    uri: parsed.data.uri,
    diagnostics: (parsed.data.diagnostics ?? []).flatMap((diagnostic) => {
      const item = DiagnosticSchema.safeParse(diagnostic);
      return item.success ? [item.data] : [];
    }),
  };
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

function fsChangeKindToLspType(kind: z.infer<typeof FsChangeKindSchema>): FileEvent["type"] {
  if (kind === "added") return FileChangeType.Created;
  if (kind === "deleted") return FileChangeType.Deleted;
  return FileChangeType.Changed;
}

const handlerMetadata = {
  didOpen: defineHandler({
    kind: "notify",
    lspMethod: "textDocument/didOpen",
    inSchema: DidOpenArgsSchema,
    outSchema: VoidResultSchema,
    emptyResponse: null,
    route: routeOpenedDocument,
    params: ({ uri, languageId, version, text }) => ({
      textDocument: { uri, languageId, version, text },
    }),
    invoke: (adapter, _lspMethod, params) => {
      adapter.notifyTextDocumentDidOpen(
        params as Parameters<LspAdapter["notifyTextDocumentDidOpen"]>[0],
      );
      return null;
    },
    after: (manager, { uri }, routed) => {
      manager.uriIndex.set(uri, {
        workspaceId: routed.workspaceId,
        presetLanguageId: routed.languageId,
      });
    },
  }),

  didChange: defineHandler({
    kind: "notify",
    lspMethod: "textDocument/didChange",
    inSchema: DidChangeArgsSchema,
    outSchema: VoidResultSchema,
    emptyResponse: null,
    route: routeByUri,
    params: ({ uri, version, contentChanges }) => ({
      textDocument: { uri, version },
      contentChanges,
    }),
    invoke: (adapter, _lspMethod, params) => {
      adapter.notifyTextDocumentDidChange(
        params as Parameters<LspAdapter["notifyTextDocumentDidChange"]>[0],
      );
      return null;
    },
  }),

  didSave: defineHandler({
    kind: "notify",
    lspMethod: "textDocument/didSave",
    inSchema: DidSaveArgsSchema,
    outSchema: VoidResultSchema,
    emptyResponse: null,
    route: routeByUri,
    params: ({ uri, text }) => ({
      textDocument: { uri },
      ...(text !== undefined ? { text } : {}),
    }),
    invoke: (adapter, _lspMethod, params) => {
      adapter.notifyTextDocumentDidSave(
        params as Parameters<LspAdapter["notifyTextDocumentDidSave"]>[0],
      );
      return null;
    },
  }),

  didClose: defineHandler({
    kind: "notify",
    lspMethod: "textDocument/didClose",
    inSchema: TextDocumentIdentifierSchema,
    outSchema: VoidResultSchema,
    emptyResponse: null,
    route: routeByUri,
    params: ({ uri }) => ({ textDocument: { uri } }),
    invoke: (adapter, _lspMethod, params) => {
      adapter.notifyTextDocumentDidClose(
        params as Parameters<LspAdapter["notifyTextDocumentDidClose"]>[0],
      );
      return null;
    },
    after: (manager, { uri }) => {
      manager.uriIndex.delete(uri);
    },
  }),

  hover: defineHandler({
    kind: "request",
    lspMethod: "textDocument/hover",
    capabilityKey: "hoverProvider",
    inSchema: TextDocumentPositionArgsSchema,
    outSchema: HoverResultSchema.nullable(),
    emptyResponse: null,
    route: routeByUri,
    params: textDocumentPositionParams,
    transform: normalizeHoverResult,
  }),

  definition: defineHandler({
    kind: "request",
    lspMethod: "textDocument/definition",
    capabilityKey: "definitionProvider",
    inSchema: TextDocumentPositionArgsSchema,
    outSchema: z.array(LocationSchema),
    emptyResponse: [],
    route: routeByUri,
    params: textDocumentPositionParams,
    transform: normalizeDefinitionResult,
  }),

  completion: defineHandler({
    kind: "request",
    lspMethod: "textDocument/completion",
    capabilityKey: "completionProvider",
    inSchema: TextDocumentPositionArgsSchema,
    outSchema: z.array(CompletionItemSchema),
    emptyResponse: [],
    route: routeByUri,
    params: textDocumentPositionParams,
    transform: normalizeCompletionResult,
  }),

  references: defineHandler({
    kind: "request",
    lspMethod: "textDocument/references",
    capabilityKey: "referencesProvider",
    inSchema: ReferencesArgsSchema,
    outSchema: z.array(LocationSchema),
    emptyResponse: [],
    route: routeByUri,
    params: referencesParams,
    transform: normalizeDefinitionResult,
  }),

  documentHighlight: defineHandler({
    kind: "request",
    lspMethod: "textDocument/documentHighlight",
    capabilityKey: "documentHighlightProvider",
    inSchema: TextDocumentPositionArgsSchema,
    outSchema: z.array(DocumentHighlightSchema),
    emptyResponse: [],
    route: routeByUri,
    params: textDocumentPositionParams,
    transform: normalizeDocumentHighlightResult,
  }),

  documentSymbol: defineHandler({
    kind: "request",
    lspMethod: "textDocument/documentSymbol",
    capabilityKey: "documentSymbolProvider",
    inSchema: TextDocumentIdentifierSchema,
    outSchema: z.array(DocumentSymbolSchema),
    emptyResponse: [],
    route: routeByUri,
    params: documentSymbolParams,
    transform: normalizeDocumentSymbolResult,
  }),

  workspaceSymbol: defineHandler({
    kind: "request",
    lspMethod: "workspace/symbol",
    capabilityKey: "workspaceSymbolProvider",
    inSchema: WorkspaceSymbolArgsSchema,
    outSchema: z.array(SymbolInformationSchema),
    emptyResponse: [],
    route: routeWorkspaceAdapters,
    params: ({ query }) => ({ query }),
    transform: normalizeWorkspaceSymbolResult,
  }),
} as const;

type MethodName = keyof typeof handlerMetadata;

async function invokeLspHandler(
  meta: HandlerMeta,
  adapter: LspAdapter,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const params = meta.params(args);
  if (meta.invoke) {
    return meta.invoke(adapter, meta.lspMethod, params, signal);
  }
  if (meta.kind === "notify") {
    adapter.notify(meta.lspMethod, params);
    return null;
  }
  return adapter.request(meta.lspMethod, params, { signal });
}

function parseHandlerOutput(meta: HandlerMeta, raw: unknown): unknown {
  const result = meta.transform ? meta.transform(raw) : raw;
  return meta.outSchema.parse(result);
}

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
  /** @internal */ configurationStore = new Map<string, Map<string, Map<string, unknown>>>();
  /** @internal */ watchedFileRegistrations = new Map<string, Map<string, Registration[]>>();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly inFlightCalls = new Map<string | number, AbortController>();
  private readonly pendingMainRequests = new Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private nextMainRequestId = 1;
  private readonly idleTimeoutMs: number;
  private readonly adapterFactory: LspAdapterFactory;

  constructor(opts: LspManagerOpts = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? LSP_DEFAULT_IDLE_MS;
    this.adapterFactory =
      opts.adapterFactory ??
      ((spec, workspaceId, workspaceRootUri) =>
        new StdioLspAdapter(spec, workspaceId, workspaceRootUri));
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
    const pending = this.pendingMainRequests.get(msg.id);
    if (!pending) return;

    this.pendingMainRequests.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.error) {
      pending.reject(new Error(String(msg.error)));
      return;
    }
    pending.resolve(msg.result ?? null);
  }

  private async handleNotification(msg: NotifyMsg): Promise<void> {
    if (msg.method === "fsChanged") {
      this.handleFsChanged(msg.args);
    }
  }

  private requestMain(method: string, params: unknown): Promise<unknown> {
    if (!this.port) {
      return Promise.reject(new Error("main port is not attached"));
    }

    const id = `server-${this.nextMainRequestId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMainRequests.delete(id);
        reject(new Error(`server request timed out: ${method}`));
      }, MAIN_SERVER_REQUEST_TIMEOUT_MS);
      (timeout as { unref?: () => void }).unref?.();

      this.pendingMainRequests.set(id, { resolve, reject, timeout });
      this.send({ type: "serverRequest", id, method, params });
    });
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
      this.forwardServerEvent(workspaceId, presetLanguageId, "window/logMessage", params);
    });
    adapter.onServerNotification("window/showMessage", (params) => {
      this.forwardServerEvent(workspaceId, presetLanguageId, "window/showMessage", params);
    });
    adapter.onServerNotification("$/progress", (params) => {
      this.forwardServerEvent(workspaceId, presetLanguageId, "$/progress", params);
    });

    adapter.onServerRequest("workspace/configuration", (params) =>
      this.handleWorkspaceConfiguration(workspaceId, presetLanguageId, params),
    );
    adapter.onServerRequest("client/registerCapability", (params) =>
      this.handleClientRegisterCapability(workspaceId, presetLanguageId, params),
    );
    adapter.onServerRequest("workspace/applyEdit", (params) =>
      this.handleWorkspaceApplyEdit(params),
    );
    adapter.onServerRequest("window/showMessageRequest", (params) =>
      this.handleShowMessageRequest(workspaceId, presetLanguageId, params),
    );
    adapter.onServerRequest("window/workDoneProgress/create", (params) =>
      this.handleWorkDoneProgressCreate(workspaceId, presetLanguageId, params),
    );
  }

  private forwardServerEvent(
    workspaceId: string,
    languageId: string,
    method: LspServerEventMethod,
    params: unknown,
  ): void {
    this.send({
      type: "serverEvent",
      workspaceId,
      languageId,
      method,
      params,
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

  private handleWorkspaceConfiguration(
    workspaceId: string,
    presetLanguageId: string,
    params: unknown,
  ): unknown[] {
    const parsed = ConfigurationParamsSchema.safeParse(params);
    if (!parsed.success) return [];

    const flatConfig = this.configurationStore.get(workspaceId)?.get(presetLanguageId);
    return parsed.data.items.map((item) => {
      if (!flatConfig || typeof item.section !== "string" || item.section.length === 0) {
        return null;
      }
      return lookupFlattenedConfig(flatConfig, item.section);
    });
  }

  private handleClientRegisterCapability(
    workspaceId: string,
    presetLanguageId: string,
    params: unknown,
  ): null {
    const parsed = RegistrationParamsSchema.safeParse(params);
    if (!parsed.success) return null;

    const watchedFileRegistrations = parsed.data.registrations.filter(
      (registration) => registration.method === WATCHED_FILES_METHOD,
    );
    if (watchedFileRegistrations.length === 0) return null;

    let workspaceRegistrations = this.watchedFileRegistrations.get(workspaceId);
    if (!workspaceRegistrations) {
      workspaceRegistrations = new Map<string, Registration[]>();
      this.watchedFileRegistrations.set(workspaceId, workspaceRegistrations);
    }

    const existing = workspaceRegistrations.get(presetLanguageId) ?? [];
    workspaceRegistrations.set(presetLanguageId, existing.concat(watchedFileRegistrations));
    return null;
  }

  private async handleWorkspaceApplyEdit(params: unknown): Promise<ApplyWorkspaceEditResult> {
    const parsed = ApplyWorkspaceEditParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { applied: false, failureReason: "Invalid workspace/applyEdit params" };
    }

    try {
      const result = await this.requestMain("workspace/applyEdit", parsed.data);
      const parsedResult = ApplyWorkspaceEditResultSchema.safeParse(result);
      if (parsedResult.success) return parsedResult.data;
      return { applied: false, failureReason: "Invalid workspace/applyEdit response" };
    } catch (error) {
      return {
        applied: false,
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private handleShowMessageRequest(
    workspaceId: string,
    presetLanguageId: string,
    params: unknown,
  ): unknown {
    this.forwardServerEvent(workspaceId, presetLanguageId, "window/showMessageRequest", params);

    const parsed = ShowMessageRequestParamsSchema.safeParse(params);
    if (!parsed.success) return null;
    return parsed.data.actions?.[0] ?? null;
  }

  private handleWorkDoneProgressCreate(
    workspaceId: string,
    presetLanguageId: string,
    params: unknown,
  ): null {
    const parsed = WorkDoneProgressCreateParamsSchema.safeParse(params);
    this.forwardServerEvent(
      workspaceId,
      presetLanguageId,
      "window/workDoneProgress/create",
      parsed.success ? parsed.data : params,
    );
    return null;
  }

  private handleFsChanged(params: unknown): void {
    const parsed = FsChangedArgsSchema.safeParse(params);
    if (!parsed.success) return;

    const workspaceAdapters = this.adapters.get(parsed.data.workspaceId);
    const workspaceRegistrations = this.watchedFileRegistrations.get(parsed.data.workspaceId);
    const workspaceRoot = this.workspaceRoots.get(parsed.data.workspaceId);
    if (!workspaceAdapters || !workspaceRegistrations || !workspaceRoot) return;

    const changes: FileEvent[] = parsed.data.changes.map((change) => ({
      uri: absolutePathToFileUri(path.join(workspaceRoot, change.relPath)),
      type: fsChangeKindToLspType(change.kind),
    }));
    if (changes.length === 0) return;

    for (const [presetLanguageId, adapter] of workspaceAdapters) {
      const registrations = workspaceRegistrations.get(presetLanguageId);
      if (!registrations || registrations.length === 0) continue;

      adapter.notify(WATCHED_FILES_METHOD, { changes });
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
    this.idleTimers.delete(workspaceId);
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
    for (const [workspaceId, workspaceTimers] of this.idleTimers) {
      for (const languageId of Array.from(workspaceTimers.keys())) {
        this.clearIdleTimer(workspaceId, languageId);
      }
    }
    this.idleTimers.clear();
    this.uriIndex.clear();
    this.configurationStore.clear();
    this.watchedFileRegistrations.clear();
    this.workspaceRoots.clear();
    for (const [id, pending] of this.pendingMainRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("LSP manager disposed"));
      this.pendingMainRequests.delete(id);
    }
  }
}
