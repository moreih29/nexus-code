// Handler metadata catalog — defines the mapping from IPC method names to LSP
// protocol methods, input/output schemas, routing, and result transforms.

import { z } from "zod";
import { resolveLspPresetLanguageId } from "../../shared/lsp-config";
import {
  CompletionItemSchema,
  DocumentHighlightSchema,
  DocumentSymbolSchema,
  FileChangeType,
  type FileEvent,
  HoverResultSchema,
  LocationSchema,
  ReferencesArgsSchema,
  SymbolInformationSchema,
  TextDocumentContentChangeEventSchema,
  TextDocumentIdentifierSchema,
  TextDocumentItemSchema,
  TextDocumentPositionArgsSchema,
  WorkspaceSymbolArgsSchema,
} from "../../shared/lsp-types";
import { FsChangeKindSchema } from "../../shared/types/fs";
import {
  normalizeCompletionResult,
  normalizeDefinitionResult,
  normalizeDocumentHighlightResult,
  normalizeDocumentSymbolResult,
  normalizeHoverResult,
  normalizeWorkspaceSymbolResult,
} from "./lsp-result-normalizers";
import type { LspAdapter } from "./servers/stdio-lsp-adapter";

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

export const DidOpenArgsSchema = TextDocumentItemSchema.extend({
  workspaceId: z.string(),
  workspaceRoot: z.string(),
});

export const DidChangeArgsSchema = z.object({
  uri: TextDocumentIdentifierSchema.shape.uri,
  version: TextDocumentItemSchema.shape.version,
  contentChanges: z.array(TextDocumentContentChangeEventSchema),
});

export const DidSaveArgsSchema = z.object({
  uri: TextDocumentIdentifierSchema.shape.uri,
  text: TextDocumentItemSchema.shape.text.optional(),
});

export const FsChangedArgsSchema = z.object({
  workspaceId: z.string(),
  changes: z.array(
    z.object({
      relPath: z.string(),
      kind: FsChangeKindSchema,
    }),
  ),
});

export const VoidResultSchema = z.null();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutedAdapter {
  workspaceId: string;
  languageId: string;
  adapter: LspAdapter;
}

export interface HandlerMeta {
  kind: "request" | "notify";
  lspMethod: string;
  capabilityKey?: string;
  inSchema: z.ZodTypeAny;
  outSchema: z.ZodTypeAny;
  emptyResponse: unknown;
  route: (
    manager: LspManagerContext,
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
  after?: (manager: LspManagerContext, args: unknown, routed: RoutedAdapter) => void;
}

// Minimal context surface needed by handler callbacks — avoids importing LspManager
// (which would create a circular dependency) while still giving handlers access to
// the state they need.
export interface LspManagerContext {
  adapters: Map<string, Map<string, LspAdapter>>;
  uriIndex: Map<string, { workspaceId: string; presetLanguageId: string }>;
  findAdapterForUri(uri: string): RoutedAdapter | undefined;
  getOrCreateAdapter(
    workspaceId: string,
    languageId: string,
    workspaceRoot: string,
  ): Promise<LspAdapter | null>;
  resetIdleTimer(workspaceId: string, languageId: string): void;
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
        manager: LspManagerContext,
        args: z.infer<S>,
      ) => Promise<RoutedAdapter | RoutedAdapter[] | undefined>)
    | ((
        manager: LspManagerContext,
        args: z.infer<S>,
      ) => RoutedAdapter | RoutedAdapter[] | undefined);
  params: (args: z.infer<S>) => unknown;
  transform?: (result: unknown) => unknown;
  invoke?: (
    adapter: LspAdapter,
    lspMethod: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown> | unknown;
  after?: (manager: LspManagerContext, args: z.infer<S>, routed: RoutedAdapter) => void;
}

// ---------------------------------------------------------------------------
// defineHandler + route helpers
// ---------------------------------------------------------------------------

export function defineHandler<S extends z.ZodTypeAny>(input: HandlerMetaInput<S>): HandlerMeta {
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

function routeByUri(manager: LspManagerContext, args: { uri: string }): RoutedAdapter | undefined {
  return manager.findAdapterForUri(args.uri);
}

function routeWorkspaceAdapters(
  manager: LspManagerContext,
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
  manager: LspManagerContext,
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

export function fsChangeKindToLspType(kind: z.infer<typeof FsChangeKindSchema>): FileEvent["type"] {
  if (kind === "added") return FileChangeType.Created;
  if (kind === "deleted") return FileChangeType.Deleted;
  return FileChangeType.Changed;
}

// ---------------------------------------------------------------------------
// Handler metadata catalog
// ---------------------------------------------------------------------------

export const handlerMetadata = {
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

export type MethodName = keyof typeof handlerMetadata;

// ---------------------------------------------------------------------------
// Handler invocation helpers
// ---------------------------------------------------------------------------

export async function invokeLspHandler(
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

export function parseHandlerOutput(meta: HandlerMeta, raw: unknown): unknown {
  const result = meta.transform ? meta.transform(raw) : raw;
  return meta.outSchema.parse(result);
}
