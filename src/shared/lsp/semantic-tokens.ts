import { z } from "zod";
import { NonnegativeIntegerSchema } from "../../../packages/remote-protocol/src/validation";
import { DocumentUriSchema } from "./primitives";

export const SemanticTokensArgsSchema = z.object({
  workspaceId: z.string(),
  uri: DocumentUriSchema,
});
export type SemanticTokensArgs = z.infer<typeof SemanticTokensArgsSchema>;

export const SemanticTokensResultSchema = z.object({
  resultId: z.string().optional(),
  data: z.array(NonnegativeIntegerSchema),
});
export type SemanticTokensResult = z.infer<typeof SemanticTokensResultSchema>;

export const CANONICAL_TOKEN_TYPES: readonly string[] = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
  "label",
  "intrinsic",
  "builtinConstant",
  "selfParameter",
  "clsParameter",
  "magicFunction",
  "unknown",
] as const;

export const SENTINEL_TOKEN_TYPE_INDEX = 29;

export function remapSemanticTokenData(
  data: readonly number[],
  serverTokenTypes: readonly string[],
  canonicalTokenTypes: readonly string[],
): number[] {
  const canonicalIndex = new Map<string, number>();
  for (let i = 0; i < canonicalTokenTypes.length; i++) {
    canonicalIndex.set(canonicalTokenTypes[i] as string, i);
  }

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

    result.push(deltaLine, deltaStartChar, length, canonIdx ?? sentinelIdx, modifierBits);
  }
  return result;
}
