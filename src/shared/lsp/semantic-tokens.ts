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

// ---------------------------------------------------------------------------
// Canonical client token-type legend (standard LSP 3.16 order).
//
// This is the single source of truth shared by:
//   - The renderer provider (getLegend() → Monaco uses these as token-type
//     names to look up in the theme rules).
//   - The agent-side remap (translates the server's own legend indices to
//     canonical indices so the renderer never sees server-specific ordering).
//
// The names are standard LSP token type strings. Monaco's theme rules in
// monaco-theme.ts use the same strings as token rule names, so the mapping
// is direct.
//
// Legend → palette role mapping (design.md §15.1, frozen 15-role set):
//   namespace                             → syntaxNamespace
//   type / class / enum / interface /
//     struct / typeParameter              → syntaxType
//   parameter / variable                  → syntaxVariable
//   property / enumMember                 → syntaxProperty
//   function / method / macro             → syntaxFunction (macro folded)
//   keyword / modifier / decorator        → syntaxKeyword  (folded)
//   comment                               → syntaxComment
//   string / regexp                       → syntaxString   (regexp folded)
//   number                                → syntaxNumber
//   operator                              → syntaxOperator
//   event / label                         → syntaxVariable (folded)
// ---------------------------------------------------------------------------
export const CANONICAL_TOKEN_TYPES: readonly string[] = [
  "namespace", // 0
  "type", // 1
  "class", // 2
  "enum", // 3
  "interface", // 4
  "struct", // 5
  "typeParameter", // 6
  "parameter", // 7
  "variable", // 8
  "property", // 9
  "enumMember", // 10
  "event", // 11
  "function", // 12
  "method", // 13
  "macro", // 14
  "keyword", // 15
  "modifier", // 16
  "comment", // 17
  "string", // 18
  "number", // 19
  "regexp", // 20
  "operator", // 21
  "decorator", // 22
  "label", // 23
  // Sentinel slot (index 24): used for token types that are not in the
  // canonical list. Keeping the tuple in the output preserves delta-chain
  // integrity (LSP data is delta-encoded; dropping a tuple shifts every
  // subsequent token's position). Monaco has no theme rule for "unknown" so
  // sentinel tokens receive no semantic colour and fall back to Monarch
  // highlighting — the correct behaviour for unrecognised types.
  "unknown", // 24  sentinel — no theme rule; Monarch fallback
] as const;

/** Index of the sentinel slot in CANONICAL_TOKEN_TYPES. */
export const SENTINEL_TOKEN_TYPE_INDEX = 24;

// ---------------------------------------------------------------------------
// remapSemanticTokenData
//
// Translates a semantic token data array (5-element tuples) from server-legend
// indices to canonical-legend indices.
//
// Each tuple: [deltaLine, deltaStartChar, length, tokenTypeIndex, modifierBits]
//
// LSP data is DELTA-encoded: deltaLine and deltaStartChar are relative to the
// PREVIOUS token. Removing a tuple shifts the positions of every subsequent
// token — corrupting all highlighting after the first dropped token.
//
// Therefore every input tuple produces exactly one output tuple. For tokens
// whose server type name is not in the canonical list (or whose server index
// is out-of-bounds), the tokenTypeIndex is rewritten to SENTINEL_TOKEN_TYPE_INDEX
// ("unknown"). Monaco has no theme rule for "unknown", so those tokens receive
// no semantic colour and fall back to Monarch highlighting — the correct
// behaviour. The delta chain is never disturbed.
//
// Modifiers are passed through unchanged (client legend declares empty
// tokenModifiers, so all modifier bits are effectively 0 from Monaco's view).
// ---------------------------------------------------------------------------
export function remapSemanticTokenData(
  data: readonly number[],
  serverTokenTypes: readonly string[],
  canonicalTokenTypes: readonly string[],
): number[] {
  // Build a lookup: canonical name → canonical index (O(n) build, O(1) lookup).
  const canonicalIndex = new Map<string, number>();
  for (let i = 0; i < canonicalTokenTypes.length; i++) {
    canonicalIndex.set(canonicalTokenTypes[i] as string, i);
  }

  // The sentinel index is the last slot in canonicalTokenTypes. If the caller
  // passes a list without a sentinel, fall back to the last index (still
  // produces no colour as long as that name has no theme rule).
  const sentinelIdx = canonicalTokenTypes.length - 1;

  const result: number[] = [];
  const tupleCount = Math.floor(data.length / 5);
  for (let i = 0; i < tupleCount; i++) {
    const base = i * 5;
    const deltaLine = data[base] as number;
    const deltaStartChar = data[base + 1] as number;
    const length = data[base + 2] as number;
    const serverTypeIdx = data[base + 3] as number;
    const modifierBits = data[base + 4] as number;

    const typeName = serverTokenTypes[serverTypeIdx];
    const canonIdx = typeName === undefined ? undefined : canonicalIndex.get(typeName);

    // Always emit a tuple — delta chain must stay intact.
    result.push(deltaLine, deltaStartChar, length, canonIdx ?? sentinelIdx, modifierBits);
  }
  return result;
}
