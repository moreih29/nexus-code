import type * as Monaco from "monaco-editor";
import { EDITOR_PALETTES, type EditorPalette } from "../../../../shared/editor/palette";
import type { ThemeId } from "../../../../shared/design-tokens";

// ---------------------------------------------------------------------------
// Monaco theme name registry
//
// Each ThemeId maps to a Monaco theme name string. Monaco's theme names are
// global strings; we namespace them as "nexus-<theme-id>".
// ---------------------------------------------------------------------------

export const NEXUS_THEME_NAMES: Record<ThemeId, string> = {
  "warm-dark": "nexus-warm-dark",
  "cool-dark": "nexus-cool-dark",
  "warm-light": "nexus-warm-light",
};

// Backward-compat export — existing consumers that import NEXUS_DARK_THEME_NAME
// continue to work; they get the warm-dark name which was the only theme before.
export const NEXUS_DARK_THEME_NAME = NEXUS_THEME_NAMES["warm-dark"];

// ---------------------------------------------------------------------------
// buildEditorColors — maps EditorPalette → Monaco IColors
// Unchanged from the original; all callers still go through this.
// ---------------------------------------------------------------------------

export function buildEditorColors(palette: EditorPalette): Monaco.editor.IColors {
  return {
    // word highlight
    "editor.wordHighlightBackground": palette.wordHighlightBackground,
    "editor.wordHighlightStrongBackground": palette.wordHighlightStrongBackground,
    "editor.wordHighlightTextBackground": palette.wordHighlightTextBackground,
    // find/match
    "editor.findRangeHighlightBackground": palette.findRangeHighlightBackground,
    "editor.findMatchHighlightBackground": palette.findMatchHighlightBackground,
    "editor.findMatchBackground": palette.findMatchBackground,
    // peek
    "peekView.border": palette.peekViewBorder,
    "peekViewEditor.matchHighlightBackground": palette.peekViewEditorMatchHighlightBackground,
    "peekViewResult.matchHighlightBackground": palette.peekViewResultMatchHighlightBackground,
    "peekViewResult.background": palette.peekViewResultBackground,
    // link
    // palette.linkForeground is reserved for future custom decorations / inline link rendering
    "editorLink.activeForeground": palette.linkActiveForeground,
    // selection
    "editor.selectionBackground": palette.selectionBackground,
    "editor.inactiveSelectionBackground": palette.inactiveSelectionBackground,
    "editor.selectionHighlightBackground": palette.selectionHighlightBackground,
    // widget surfaces
    "editorHoverWidget.background": palette.hoverWidgetBackground,
    "editorHoverWidget.border": palette.hoverWidgetBorder,
    "editorWidget.background": palette.editorWidgetBackground,
    "editorWidget.border": palette.editorWidgetBorder,
    // diagnostic
    "editorError.foreground": palette.errorForeground,
    "editorWarning.foreground": palette.warningForeground,
    "editorInfo.foreground": palette.infoForeground,
    "editorHint.foreground": palette.hintForeground,
    "editorError.background": palette.errorBackground,
    "editorWarning.background": palette.warningBackground,
    "editorInfo.background": palette.infoBackground,
    "editorHint.background": palette.hintBackground,
  };
}

// ---------------------------------------------------------------------------
// Theme base: warm-light uses "vs" (light base); dark themes use "vs-dark".
// This ensures Monaco's built-in token colorization starts from the right
// luminance baseline before our palette overrides apply.
// ---------------------------------------------------------------------------

function monacoBase(themeId: ThemeId): Monaco.editor.BuiltinTheme {
  return themeId === "warm-light" ? "vs" : "vs-dark";
}

// ---------------------------------------------------------------------------
// initializeMonacoTheme — pre-register all 3 themes at startup.
//
// Called once from initializeEditorServices(monaco) in editor/index.ts.
// The WeakSet guard prevents double-registration if the monaco instance
// is replaced (hot-reload in dev).
// ---------------------------------------------------------------------------

const initializedThemeMonacos = new WeakSet<object>();

export function initializeMonacoTheme(monaco: typeof Monaco): void {
  if (initializedThemeMonacos.has(monaco)) return;

  for (const [themeId, themeName] of Object.entries(NEXUS_THEME_NAMES) as [ThemeId, string][]) {
    monaco.editor.defineTheme(themeName, {
      base: monacoBase(themeId),
      inherit: true,
      rules: [],
      colors: buildEditorColors(EDITOR_PALETTES[themeId]),
    });
  }

  initializedThemeMonacos.add(monaco);

  // Subscribe to nexus:theme-changed CustomEvent dispatched by useThemeEffect.
  // monaco.editor.setTheme() is a global operation — it applies instantly to
  // all mounted editor instances without any per-instance prop change.
  subscribeMonacoThemeChanges(monaco);
}

// ---------------------------------------------------------------------------
// subscribeMonacoThemeChanges — attach a documentElement listener for the
// nexus:theme-changed CustomEvent dispatched by useThemeEffect.
//
// The listener is registered on documentElement (not document) to match
// the dispatch target in use-theme-effect.ts:
//   document.documentElement.dispatchEvent(new CustomEvent("nexus:theme-changed", ...))
//
// Returns a cleanup function (called by test teardown; not needed in prod
// because the listener persists for the app's lifetime).
// ---------------------------------------------------------------------------

type ThemeChangedDetail = { themeId: ThemeId };

export function subscribeMonacoThemeChanges(monaco: typeof Monaco): () => void {
  const handler = (e: Event) => {
    const themeId = (e as CustomEvent<ThemeChangedDetail>).detail?.themeId;
    if (!themeId) return;
    const themeName = NEXUS_THEME_NAMES[themeId];
    if (!themeName) return;
    monaco.editor.setTheme(themeName);
  };

  document.documentElement.addEventListener("nexus:theme-changed", handler);
  return () => {
    document.documentElement.removeEventListener("nexus:theme-changed", handler);
  };
}
