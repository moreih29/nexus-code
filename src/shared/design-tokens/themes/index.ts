// themes/index.ts — Theme registry built from THEME_SOURCES via the adapter.
//
// Single source of truth: ../theme-sources.ts (10 ThemeSource records).
// Adapter: ../theme-adapter.ts (buildSemanticTokens).
//
// To add a new theme: append a ThemeSource entry in theme-sources.ts.
// ThemeId, THEMES, DEFAULT_THEME, EDITOR_PALETTES all expand automatically.
//
// design.md §15: external themes are imported as-is. The §1 "C ≤ 0.012"
// chrome chroma constraint was discarded when external theme adoption
// became the canonical source of theme variety.

import type { SemanticTokenSet } from "../semantic";
import { buildSemanticTokens } from "../theme-adapter";
import {
  THEME_SOURCES,
  THEME_SOURCE_BY_ID,
  DEFAULT_THEME,
  type ThemeId,
} from "../theme-sources";

// ---------------------------------------------------------------------------
// THEMES — runtime registry: ThemeId → SemanticTokenSet (built via adapter).
// generate-theme-css.ts iterates this map to emit [data-theme="*"] blocks.
// ---------------------------------------------------------------------------

export const THEMES: Record<ThemeId, SemanticTokenSet> = Object.fromEntries(
  THEME_SOURCES.map((source) => [source.id, buildSemanticTokens(source)]),
) as Record<ThemeId, SemanticTokenSet>;

// ---------------------------------------------------------------------------
// Public surface — id types + default + source lookup re-exports.
// ---------------------------------------------------------------------------

export { DEFAULT_THEME, THEME_SOURCES, THEME_SOURCE_BY_ID };
export type { ThemeId };
