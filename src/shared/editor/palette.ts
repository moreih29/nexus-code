// Editor color palette — Monaco-side surface chrome + syntax token colors.
//
// This file used to contain inline EditorPalette records per theme. With the
// adapter-based theme system (see design-tokens/theme-adapter.ts), every
// theme's Monaco palette is now derived from the same ThemeSource that
// produces its SemanticTokenSet. We re-export the adapter output here so the
// existing import path (`shared/editor/palette`) stays stable.
//
// Format constraint (preserved from the previous incarnation):
//   ALL values are 8-digit hex (#rrggbbaa) — Monaco's standalone theme
//   parser rejects rgba()/oklch()/named-color forms and falls back to a
//   #ff0000 sentinel otherwise. The adapter handles the conversion via
//   culori formatHex8.

import {
  buildEditorPalette,
  THEME_SOURCES,
  type EditorPalette,
  type ThemeId,
} from "../design-tokens";

export type { EditorPalette };

// ---------------------------------------------------------------------------
// EDITOR_PALETTES — derived palette per ThemeId. Iterates THEME_SOURCES so
// adding a theme to the source data automatically widens this map.
// ---------------------------------------------------------------------------

export const EDITOR_PALETTES: Record<ThemeId, EditorPalette> = Object.fromEntries(
  THEME_SOURCES.map((source) => [source.id, buildEditorPalette(source)]),
) as Record<ThemeId, EditorPalette>;
