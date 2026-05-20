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
// the workspace agent), not something Monaco can decide for us.

import {
  BUILTIN_LSP_PRESETS,
  isSupportedLspLanguage,
  type LSP_LANGUAGE_PRESET_ALIASES,
} from "../../../../shared/lsp/config";

// All Monaco languageIds that should route through our LSP bridge. This
// must mirror LSP_LANGUAGE_PRESET_ALIASES — every aliased Monaco id needs
// to opt in here, or the renderer silently drops didOpen for that
// language and Monaco's built-in TS worker takes over with wrong defaults.
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
