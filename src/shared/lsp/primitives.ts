import { z } from "zod";

export const DocumentUriSchema = z.string();
export type DocumentUri = z.infer<typeof DocumentUriSchema>;

export const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
export type Position = z.infer<typeof PositionSchema>;

export const RangeSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});
export type Range = z.infer<typeof RangeSchema>;

export const LocationSchema = z.object({
  uri: DocumentUriSchema,
  range: RangeSchema,
});
export type Location = z.infer<typeof LocationSchema>;

export const LocationLinkSchema = z.object({
  originSelectionRange: RangeSchema.optional(),
  targetUri: DocumentUriSchema,
  targetRange: RangeSchema,
  targetSelectionRange: RangeSchema,
});
export type LocationLink = z.infer<typeof LocationLinkSchema>;

export const TextEditSchema = z.object({
  range: RangeSchema,
  newText: z.string(),
});
export type TextEdit = z.infer<typeof TextEditSchema>;

export const MarkupContentSchema = z.object({
  kind: z.enum(["plaintext", "markdown"]),
  value: z.string(),
});
export type MarkupContent = z.infer<typeof MarkupContentSchema>;

export const MarkupContentOrStringSchema = z.union([MarkupContentSchema, z.string()]);
export type MarkupContentOrString = z.infer<typeof MarkupContentOrStringSchema>;
