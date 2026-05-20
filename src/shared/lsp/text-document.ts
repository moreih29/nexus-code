import { z } from "zod";
import { DocumentUriSchema, PositionSchema, RangeSchema } from "./primitives";

export const TextDocumentIdentifierSchema = z.object({
  uri: DocumentUriSchema,
});
export type TextDocumentIdentifier = z.infer<typeof TextDocumentIdentifierSchema>;

export const VersionedTextDocumentIdentifierSchema = TextDocumentIdentifierSchema.extend({
  version: z.number().int().nullable(),
});
export type VersionedTextDocumentIdentifier = z.infer<typeof VersionedTextDocumentIdentifierSchema>;

export const TextDocumentItemSchema = z.object({
  uri: DocumentUriSchema,
  languageId: z.string(),
  version: z.number().int(),
  text: z.string(),
});
export type TextDocumentItem = z.infer<typeof TextDocumentItemSchema>;

export const TextDocumentSyncKind = {
  None: 0,
  Full: 1,
  Incremental: 2,
} as const;

export const TextDocumentSyncKindSchema = z.union([
  z.literal(TextDocumentSyncKind.None),
  z.literal(TextDocumentSyncKind.Full),
  z.literal(TextDocumentSyncKind.Incremental),
]);
export type TextDocumentSyncKind = z.infer<typeof TextDocumentSyncKindSchema>;

export const FullTextDocumentContentChangeEventSchema = z
  .object({
    text: z.string(),
  })
  .strict();
export type FullTextDocumentContentChangeEvent = z.infer<
  typeof FullTextDocumentContentChangeEventSchema
>;

export const IncrementalTextDocumentContentChangeEventSchema = z
  .object({
    range: RangeSchema,
    rangeLength: z.number().int().nonnegative().optional(),
    text: z.string(),
  })
  .strict();
export type IncrementalTextDocumentContentChangeEvent = z.infer<
  typeof IncrementalTextDocumentContentChangeEventSchema
>;

export const TextDocumentContentChangeEventSchema = z.union([
  IncrementalTextDocumentContentChangeEventSchema,
  FullTextDocumentContentChangeEventSchema,
]);
export type TextDocumentContentChangeEvent = z.infer<typeof TextDocumentContentChangeEventSchema>;

export const ServerCapabilitiesSchema = z.record(z.unknown());
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;

// Renderer → main IPC argument shape for position-scoped LSP requests
// (hover / definition / completion / documentHighlight). `workspaceId`
// scopes the request to a specific workspace's LSP server — the same
// physical file URI can be open in multiple workspaces, and routing
// purely by URI would conflate them. The renderer extracts workspaceId
// from the model's cacheUri (see workspace-uri.ts).
export const TextDocumentPositionArgsSchema = z.object({
  workspaceId: z.string(),
  uri: DocumentUriSchema,
  line: PositionSchema.shape.line,
  character: PositionSchema.shape.character,
});
export type TextDocumentPositionArgs = z.infer<typeof TextDocumentPositionArgsSchema>;

export const ReferencesArgsSchema = TextDocumentPositionArgsSchema.extend({
  includeDeclaration: z.boolean(),
});
export type ReferencesArgs = z.infer<typeof ReferencesArgsSchema>;

export const WorkspaceSymbolArgsSchema = z.object({
  workspaceId: z.string(),
  query: z.string(),
});
export type WorkspaceSymbolArgs = z.infer<typeof WorkspaceSymbolArgsSchema>;
