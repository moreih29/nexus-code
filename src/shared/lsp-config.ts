export type LspServerSpec = {
  languageId: string;
  binary: string;
  args: readonly string[];
  initializationOptions?: unknown;
};

export const BUILTIN_LSP_PRESETS = [
  {
    languageId: "typescript",
    binary: "typescript-language-server",
    args: ["--stdio"],
    initializationOptions: {},
  },
  {
    languageId: "python",
    binary: "pyright-langserver",
    args: ["--stdio"],
    initializationOptions: {
      "python.analysis.typeCheckingMode": "standard",
      "python.analysis.diagnosticMode": "openFilesOnly",
      "python.analysis.autoImportCompletions": true,
      "python.analysis.useLibraryCodeForTypes": true,
    },
  },
] as const satisfies readonly LspServerSpec[];

export type BuiltinLspPresetLanguageId = (typeof BUILTIN_LSP_PRESETS)[number]["languageId"];

export const LSP_LANGUAGE_PRESET_ALIASES = {
  javascript: "typescript",
} as const satisfies Record<string, BuiltinLspPresetLanguageId>;

export type LspLanguagePresetAlias = keyof typeof LSP_LANGUAGE_PRESET_ALIASES;
export type SupportedLspLanguageId = BuiltinLspPresetLanguageId | LspLanguagePresetAlias;

const BUILTIN_LSP_PRESET_BY_LANGUAGE_ID = new Map<string, LspServerSpec>(
  BUILTIN_LSP_PRESETS.map((spec) => [spec.languageId, spec]),
);

export function isBuiltinLspPresetLanguageId(
  languageId: string,
): languageId is BuiltinLspPresetLanguageId {
  return BUILTIN_LSP_PRESET_BY_LANGUAGE_ID.has(languageId);
}

export function resolveLspPresetLanguageId(languageId: string): BuiltinLspPresetLanguageId | null {
  const aliasTarget =
    LSP_LANGUAGE_PRESET_ALIASES[languageId as keyof typeof LSP_LANGUAGE_PRESET_ALIASES];
  const presetLanguageId = aliasTarget ?? languageId;
  return isBuiltinLspPresetLanguageId(presetLanguageId) ? presetLanguageId : null;
}

export function resolveLspPreset(languageId: string): LspServerSpec | null {
  const presetLanguageId = resolveLspPresetLanguageId(languageId);
  if (!presetLanguageId) return null;
  return BUILTIN_LSP_PRESET_BY_LANGUAGE_ID.get(presetLanguageId) ?? null;
}

export function isSupportedLspLanguage(languageId: string): languageId is SupportedLspLanguageId {
  return resolveLspPresetLanguageId(languageId) !== null;
}
