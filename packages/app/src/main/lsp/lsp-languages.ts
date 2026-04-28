import type { LspLanguage } from "../../../../shared/src/contracts/editor/editor-bridge";

export const LSP_LANGUAGES: readonly LspLanguage[] = ["typescript", "python", "go"];

export function normalizeRequestedLanguages(
  languages: readonly LspLanguage[] | null | undefined,
): readonly LspLanguage[] {
  if (!languages || languages.length === 0) {
    return LSP_LANGUAGES;
  }

  return LSP_LANGUAGES.filter((language) => languages.includes(language));
}

export function languageIdFor(language: LspLanguage): string {
  return language;
}
