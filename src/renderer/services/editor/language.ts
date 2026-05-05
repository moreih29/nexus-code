// LSP-language allowlist used by lsp-bridge.
//
// Syntax highlighting is delegated to Monaco itself: we pass `undefined`
// as the language to `createModel` and let Monaco resolve the id from
// the URI's file extension via its registered language contributions
// (basic-languages: typescript, javascript, json, css, html, python,
// go, rust, yaml, dockerfile, shell, sql, ...). Unknown extensions
// fall back to "plaintext".
//
// What this module owns is the *LSP routing* decision — which Monaco
// language ids should the renderer push didOpen/didChange for. That's
// project policy (driven by which language servers we actually run in
// the lsp-host), not something Monaco can decide for us.

import {
  BUILTIN_LSP_PRESETS,
  isSupportedLspLanguage,
  type LSP_LANGUAGE_PRESET_ALIASES,
} from "../../../shared/lsp-config";

const JAVASCRIPT_LSP_COVERAGE = [
  "javascript",
] as const satisfies readonly (keyof typeof LSP_LANGUAGE_PRESET_ALIASES)[];

export const LSP_LANGUAGES: readonly (
  | (typeof BUILTIN_LSP_PRESETS)[number]["languageId"]
  | (typeof JAVASCRIPT_LSP_COVERAGE)[number]
)[] = [...BUILTIN_LSP_PRESETS.map((preset) => preset.languageId), ...JAVASCRIPT_LSP_COVERAGE];
export type LspLanguage = (typeof LSP_LANGUAGES)[number];

export function isLspLanguage(languageId: string): languageId is LspLanguage {
  return (
    (LSP_LANGUAGES as readonly string[]).includes(languageId) && isSupportedLspLanguage(languageId)
  );
}
