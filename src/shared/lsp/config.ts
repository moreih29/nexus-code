import { z } from "zod";

export type LspServerSpec = {
  languageId: string;
  binary: string;
  args: readonly string[];
  initializationOptions?: unknown;
  system?: boolean;
  install?: string;
};

export const BUILTIN_LSP_PRESETS = [
  {
    languageId: "typescript",
    binary: "typescript-language-server",
    args: ["--stdio"],
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
  {
    languageId: "yaml",
    binary: "yaml-language-server",
    args: ["--stdio"],
  },
  {
    languageId: "shell",
    binary: "bash-language-server",
    args: ["start"],
  },
  {
    languageId: "dockerfile",
    binary: "docker-langserver",
    args: ["--stdio"],
  },
  {
    languageId: "go",
    binary: "gopls",
    args: [],
    system: true,
    install: "go install golang.org/x/tools/gopls@latest",
  },
  {
    languageId: "rust",
    binary: "rust-analyzer",
    args: [],
    system: true,
    install: "rustup component add rust-analyzer",
  },
] as const satisfies readonly LspServerSpec[];

export type BuiltinLspPresetLanguageId = (typeof BUILTIN_LSP_PRESETS)[number]["languageId"];

export const LspPresetLanguageIdSchema = z.enum(
  BUILTIN_LSP_PRESETS.map((preset) => preset.languageId) as [
    BuiltinLspPresetLanguageId,
    ...BuiltinLspPresetLanguageId[],
  ],
);

export const LSP_LANGUAGE_PRESET_ALIASES = {
  javascript: "typescript",
  typescriptreact: "typescript",
  javascriptreact: "typescript",
  shellscript: "shell",
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

const LSP_PRESET_EXTENSIONS: Record<string, BuiltinLspPresetLanguageId> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "typescript",
  jsx: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  py: "python",
  pyi: "python",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  dockerfile: "dockerfile",
  go: "go",
  rs: "rust",
};

const LSP_PRESET_FILENAMES: Record<string, BuiltinLspPresetLanguageId> = {
  dockerfile: "dockerfile",
};

export function lspPresetLanguageIdForPath(filePath: string): BuiltinLspPresetLanguageId | null {
  const name = filePath.slice(filePath.search(/[^/\\]*$/));
  const byName = LSP_PRESET_FILENAMES[name.toLowerCase()];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return LSP_PRESET_EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

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
  if (monacoLanguageId === "shell") return "shellscript";
  return monacoLanguageId;
}
