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

export const LSP_LANGUAGES = ["typescript", "javascript"] as const;
export type LspLanguage = (typeof LSP_LANGUAGES)[number];

export function isLspLanguage(languageId: string): languageId is LspLanguage {
  return (LSP_LANGUAGES as readonly string[]).includes(languageId);
}
