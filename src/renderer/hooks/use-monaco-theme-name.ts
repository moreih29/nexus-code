// src/renderer/hooks/use-monaco-theme-name.ts — Derives the Monaco theme name
// from the resolved Nexus theme in the theme store.
//
// Returns the Monaco-registered string (e.g. "nexus-warm-dark") that
// corresponds to the currently resolved ThemeId so editor components can pass
// it as the initial `theme` prop without hardcoding a single palette.
//
// Note: this hook covers the *initial mount* value only. Post-mount palette
// changes are handled globally by subscribeMonacoThemeChanges (called once
// from initializeMonacoTheme). Adding a per-component setTheme effect would
// duplicate that global listener and is therefore intentionally absent here.

import { NEXUS_THEME_NAMES } from "../services/editor/runtime/monaco-theme";
import { useThemeStore } from "../state/stores/theme";

/**
 * Returns the Monaco theme name string for the currently resolved Nexus theme.
 * Use as the `theme` prop on `<Editor>` and `<DiffEditor>` to ensure the
 * first paint matches the active UI palette.
 */
export function useMonacoThemeName(): string {
  return useThemeStore((s) => NEXUS_THEME_NAMES[s.resolved]);
}
