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
    // typescript-language-server forwards `hostInfo` and `preferences`
    // into tsserver's session. With an empty object the server has been
    // observed to fall into an inferred-project default where JSX
    // parsing is off for .tsx files even with a valid local tsconfig
    // declaring `"jsx": "react-jsx"`. `hostInfo` identifies the editor
    // (VSCode sends "vscode") and `preferences: {}` opts us into the
    // configured-client codepath rather than the never-configured one.
    initializationOptions: {
      hostInfo: "nexus-code",
      preferences: {},
    },
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

// Monaco assigns distinct languageIds per file extension —
//   .ts  → "typescript"
//   .tsx → "typescriptreact"
//   .js  → "javascript"
//   .jsx → "javascriptreact"
// typescript-language-server handles all four flavours natively (passes the
// languageId through to tsserver, which switches JSX parsing accordingly).
// On our side we just need to route every variant to the same preset so the
// LSP host shares one server per workspace across all four.
export const LSP_LANGUAGE_PRESET_ALIASES = {
  javascript: "typescript",
  typescriptreact: "typescript",
  javascriptreact: "typescript",
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

/**
 * Coerce a Monaco-derived `languageId` to the LSP-canonical id based on the
 * file URI extension.
 *
 * Why this exists: Monaco's built-in typescript contribution registers a
 * single languageId "typescript" against both `.ts` and `.tsx` (and
 * "javascript" against both `.js` and `.jsx`). It does NOT register a
 * separate "typescriptreact" / "javascriptreact" languageId. So a `.tsx`
 * file's `model.getLanguageId()` returns "typescript", and forwarding that
 * verbatim to typescript-language-server causes tsserver to open the file
 * with ScriptKind.TS (not TSX). With JSX parsing off the source
 *   `return <RouterProvider router={router} />;`
 * is parsed as a comparison + division + unterminated regex, surfacing as
 *   2:1   "'RouterProvider' is declared but its value is never read"
 *   27:11 "'RouterProvider' refers to a value, but is being used as a type"
 *   27:26 "'>' expected"
 *   27:42 "Unterminated regular expression literal"
 * The fix is to send the LSP the languageId that matches the file
 * extension regardless of what Monaco's contribution table says.
 */
export function lspLanguageIdForUri(monacoLanguageId: string, uri: string): string {
  const lower = uri.toLowerCase();
  if (
    (monacoLanguageId === "typescript" || monacoLanguageId === "typescriptreact") &&
    lower.endsWith(".tsx")
  ) {
    return "typescriptreact";
  }
  if (
    (monacoLanguageId === "javascript" || monacoLanguageId === "javascriptreact") &&
    lower.endsWith(".jsx")
  ) {
    return "javascriptreact";
  }
  return monacoLanguageId;
}
