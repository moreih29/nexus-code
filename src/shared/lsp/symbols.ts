import { z } from "zod";
import { type Range, LocationSchema, RangeSchema } from "./primitives";

export const SymbolKindSchema = z.number().int().min(1).max(26);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

export const SymbolTagSchema = z.literal(1);
export type SymbolTag = z.infer<typeof SymbolTagSchema>;

export const SymbolInformationSchema = z.object({
  name: z.string(),
  kind: SymbolKindSchema,
  tags: z.array(SymbolTagSchema).optional(),
  deprecated: z.boolean().optional(),
  location: LocationSchema,
  containerName: z.string().optional(),
});
export type SymbolInformation = z.infer<typeof SymbolInformationSchema>;

export const DocumentHighlightKindSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type DocumentHighlightKind = z.infer<typeof DocumentHighlightKindSchema>;

export const DocumentHighlightSchema = z.object({
  range: RangeSchema,
  kind: DocumentHighlightKindSchema.optional(),
});
export type DocumentHighlight = z.infer<typeof DocumentHighlightSchema>;

export interface DocumentSymbol {
  name: string;
  detail?: string | undefined;
  kind: SymbolKind;
  tags?: SymbolTag[] | undefined;
  deprecated?: boolean | undefined;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[] | undefined;
}

export const DocumentSymbolSchema: z.ZodType<DocumentSymbol> = z.lazy(() =>
  z.object({
    name: z.string(),
    detail: z.string().optional(),
    kind: SymbolKindSchema,
    tags: z.array(SymbolTagSchema).optional(),
    deprecated: z.boolean().optional(),
    range: RangeSchema,
    selectionRange: RangeSchema,
    children: z.array(DocumentSymbolSchema).optional(),
  }),
);

export const CompletionItemSchema = z.object({
  label: z.string(),
  kind: z.number().int().optional(),
});
export type CompletionItem = z.infer<typeof CompletionItemSchema>;
