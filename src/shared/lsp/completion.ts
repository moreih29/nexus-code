import { z } from "zod";
import { IntegerSchema } from "../../../packages/remote-protocol/src/validation";
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

export const CompletionItemSchema = z.object({
  label: z.string(),
  labelDetails: CompletionItemLabelDetailsSchema.optional(),
  kind: IntegerSchema.optional(),
  tags: z.array(IntegerSchema).optional(),
  detail: z.string().optional(),
  documentation: MarkupContentOrStringSchema.optional(),
  deprecated: z.boolean().optional(),
  preselect: z.boolean().optional(),
  sortText: z.string().optional(),
  filterText: z.string().optional(),
  insertText: z.string().optional(),
  insertTextFormat: IntegerSchema.optional(),
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

export const CompletionTriggerKind = {
  Invoked: 1,
  TriggerCharacter: 2,
  TriggerForIncompleteCompletions: 3,
} as const;

export const CompletionArgsSchema = TextDocumentPositionArgsSchema.extend({
  triggerKind: IntegerSchema.optional(),
  triggerCharacter: z.string().optional(),
});
export type CompletionArgs = z.infer<typeof CompletionArgsSchema>;

export const CompletionResolveArgsSchema = z.object({
  workspaceId: z.string(),
  uri: DocumentUriSchema,
  item: CompletionItemSchema,
});
export type CompletionResolveArgs = z.infer<typeof CompletionResolveArgsSchema>;
