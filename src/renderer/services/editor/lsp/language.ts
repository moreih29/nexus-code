import {
  BUILTIN_LSP_PRESETS,
  isSupportedLspLanguage,
  type LSP_LANGUAGE_PRESET_ALIASES,
} from "../../../../shared/lsp/config";

const TYPESCRIPT_VARIANT_ALIASES = [
  "javascript",
  "typescriptreact",
  "javascriptreact",
] as const satisfies readonly (keyof typeof LSP_LANGUAGE_PRESET_ALIASES)[];

export const LSP_LANGUAGES: readonly (
  | (typeof BUILTIN_LSP_PRESETS)[number]["languageId"]
  | (typeof TYPESCRIPT_VARIANT_ALIASES)[number]
)[] = [...BUILTIN_LSP_PRESETS.map((preset) => preset.languageId), ...TYPESCRIPT_VARIANT_ALIASES];
export type LspLanguage = (typeof LSP_LANGUAGES)[number];

export function isLspLanguage(languageId: string): languageId is LspLanguage {
  return (
    (LSP_LANGUAGES as readonly string[]).includes(languageId) && isSupportedLspLanguage(languageId)
  );
}
