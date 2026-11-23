import {
  buildEditorPalette,
  type EditorPalette,
  THEME_SOURCES,
  type ThemeId,
} from "../design-tokens";

export type { EditorPalette };

export const EDITOR_PALETTES: Record<ThemeId, EditorPalette> = Object.fromEntries(
  THEME_SOURCES.map((source) => [source.id, buildEditorPalette(source)]),
) as Record<ThemeId, EditorPalette>;
