// File extension → Monaco language id mapping, plus the LSP-language
// allowlist that lsp-bridge uses. Kept together because the two are
// semantically linked: a language only meaningfully reaches the LSP
// path if languageIdForPath can return it. Splitting them risked
// silent drift (e.g. adding ".py" to languageIdForPath without also
// adding "python" to LSP_LANGUAGES, or vice versa).
//
// Default for unknown extensions is "plaintext" — Monaco treats that as
// "no syntax service", which is the safe non-feature for unknown files.

export const LSP_LANGUAGES = ["typescript", "javascript"] as const;
export type LspLanguage = (typeof LSP_LANGUAGES)[number];

export function isLspLanguage(languageId: string): languageId is LspLanguage {
  return (LSP_LANGUAGES as readonly string[]).includes(languageId);
}

export function languageIdForPath(filePath: string): string {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  const extension = basename.includes(".")
    ? basename.slice(basename.lastIndexOf(".")).toLowerCase()
    : "";

  switch (extension) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    case ".css":
      return "css";
    case ".html":
    case ".htm":
      return "html";
    case ".md":
    case ".markdown":
      return "markdown";
    default:
      return "plaintext";
  }
}
