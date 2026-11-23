import type { SemanticTokenSet } from "../semantic";
import { buildSemanticTokens } from "../theme-adapter";
import { DEFAULT_THEME, THEME_SOURCE_BY_ID, THEME_SOURCES, type ThemeId } from "../theme-sources";

export const THEMES: Record<ThemeId, SemanticTokenSet> = Object.fromEntries(
  THEME_SOURCES.map((source) => [source.id, buildSemanticTokens(source)]),
) as Record<ThemeId, SemanticTokenSet>;

export type { ThemeId };
export { DEFAULT_THEME, THEME_SOURCE_BY_ID, THEME_SOURCES };
