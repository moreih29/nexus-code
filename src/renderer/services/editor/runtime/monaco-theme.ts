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
    // editor surface — translucent so the macOS window vibrancy shows through.
    "editor.background": palette.editorBackground,
    "editorGutter.background": palette.editorBackground,
  };
}

// ---------------------------------------------------------------------------
// buildSyntaxRules — maps EditorPalette.syntax* → Monaco ITokenThemeRule[]
//
// design.md §15.1: code syntax is authored with the Nexus palette, replacing
// the inherited Monaco vs/vs-dark token colors (the old `rules: []`).
//
// Monaco's `foreground` field expects a 6-digit hex WITHOUT the leading "#";
// the syntax* palette values are #rrggbb literals, so we strip it.
//
// `token` matches by dotted-prefix: a rule for "string" also colors
// "string.escape", "string.json", etc. More specific rules (e.g. "string.key")
// win over shorter prefixes. Token-type names below are the ones emitted by
// Monaco's bundled Monarch tokenizers (TS/JS/JSON/HTML/CSS). Function/property/
// variable coloring from Monarch alone is limited — those grammars mostly emit
// `identifier`; richer coloring would require semantic tokens (future work).
// ---------------------------------------------------------------------------

function buildSyntaxRules(palette: EditorPalette): Monaco.editor.ITokenThemeRule[] {
  const fg = (hex: string) => hex.replace(/^#/, "");
  return [
    { token: "comment", foreground: fg(palette.syntaxComment), fontStyle: "italic" },
    { token: "keyword", foreground: fg(palette.syntaxKeyword) },
    { token: "annotation", foreground: fg(palette.syntaxKeyword) },
    { token: "string", foreground: fg(palette.syntaxString) },
    { token: "string.key", foreground: fg(palette.syntaxProperty) },
    { token: "attribute.value", foreground: fg(palette.syntaxString) },
    { token: "number", foreground: fg(palette.syntaxNumber) },
    { token: "constant", foreground: fg(palette.syntaxConstant) },
    { token: "regexp", foreground: fg(palette.syntaxRegexp) },
    { token: "operator", foreground: fg(palette.syntaxOperator) },
    { token: "delimiter", foreground: fg(palette.syntaxOperator) },
    { token: "type", foreground: fg(palette.syntaxType) },
    { token: "type.identifier", foreground: fg(palette.syntaxType) },
    { token: "namespace", foreground: fg(palette.syntaxNamespace) },
    { token: "function", foreground: fg(palette.syntaxFunction) },
    { token: "identifier", foreground: fg(palette.syntaxVariable) },
    { token: "variable", foreground: fg(palette.syntaxVariable) },
    { token: "tag", foreground: fg(palette.syntaxTag) },
    { token: "metatag", foreground: fg(palette.syntaxTag) },
    { token: "attribute.name", foreground: fg(palette.syntaxAttribute) },
    { token: "invalid", foreground: fg(palette.syntaxInvalid) },
  ];
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
      rules: buildSyntaxRules(EDITOR_PALETTES[themeId]),
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
