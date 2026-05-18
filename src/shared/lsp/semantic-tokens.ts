import { z } from "zod";
import { DocumentUriSchema } from "./primitives";

// ---------------------------------------------------------------------------
// SemanticTokens — LSP §3.16 textDocument/semanticTokens/full
//
// The server returns a flat `data` array in the LSP relative-encoding format:
//   [deltaLine, deltaStartChar, length, tokenTypeIndex, tokenModifiersBitfield]
// for each token. The client-capability advertisement (client-capabilities.ts)
// requests full-document mode only; delta (edits) mode is not used.
// ---------------------------------------------------------------------------

export const SemanticTokensArgsSchema = z.object({
  uri: DocumentUriSchema,
});
export type SemanticTokensArgs = z.infer<typeof SemanticTokensArgsSchema>;

export const SemanticTokensResultSchema = z.object({
  resultId: z.string().optional(),
  data: z.array(z.number().int().nonnegative()),
});
export type SemanticTokensResult = z.infer<typeof SemanticTokensResultSchema>;
