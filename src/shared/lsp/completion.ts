import { z } from "zod";
import {
  DocumentUriSchema,
  MarkupContentOrStringSchema,
  RangeSchema,
  TextEditSchema,
} from "./primitives";
import { TextDocumentPositionArgsSchema } from "./text-document";

export const InsertReplaceEditSchema = z.object({
  newText: z.string(),
  insert: RangeSchema,
  replace: RangeSchema,
});
export type InsertReplaceEdit = z.infer<typeof InsertReplaceEditSchema>;

export const CompletionItemLabelDetailsSchema = z.object({
  detail: z.string().optional(),
  description: z.string().optional(),
});

export const CompletionItemTagDeprecated = 1;
export const InsertTextFormatSnippet = 2;

/**
 * The fields of an LSP completion item the editor uses. `data` is the
 * server's own, kept so `completionItem/resolve` gets it back.
 */
export const CompletionItemSchema = z.object({
  label: z.string(),
  labelDetails: CompletionItemLabelDetailsSchema.optional(),
  kind: z.number().int().optional(),
  tags: z.array(z.number().int()).optional(),
  detail: z.string().optional(),
  documentation: MarkupContentOrStringSchema.optional(),
  deprecated: z.boolean().optional(),
  preselect: z.boolean().optional(),
  sortText: z.string().optional(),
  filterText: z.string().optional(),
  insertText: z.string().optional(),
  insertTextFormat: z.number().int().optional(),
  textEdit: z.union([TextEditSchema, InsertReplaceEditSchema]).optional(),
  additionalTextEdits: z.array(TextEditSchema).optional(),
  commitCharacters: z.array(z.string()).optional(),
  command: z.object({ title: z.string(), command: z.string() }).optional(),
  data: z.unknown().optional(),
});
export type CompletionItem = z.infer<typeof CompletionItemSchema>;

export const CompletionListSchema = z.object({
  isIncomplete: z.boolean(),
  items: z.array(CompletionItemSchema),
});
export type CompletionList = z.infer<typeof CompletionListSchema>;

/** LSP's CompletionTriggerKind. */
export const CompletionTriggerKind = {
  Invoked: 1,
  TriggerCharacter: 2,
  TriggerForIncompleteCompletions: 3,
} as const;

// Renderer → main: what typed the request, so main can skip characters the
// server does not complete on and pass the context on to it.
export const CompletionArgsSchema = TextDocumentPositionArgsSchema.extend({
  triggerKind: z.number().int().optional(),
  triggerCharacter: z.string().optional(),
});
export type CompletionArgs = z.infer<typeof CompletionArgsSchema>;

export const CompletionResolveArgsSchema = z.object({
  workspaceId: z.string(),
  uri: DocumentUriSchema,
  item: CompletionItemSchema,
});
export type CompletionResolveArgs = z.infer<typeof CompletionResolveArgsSchema>;
