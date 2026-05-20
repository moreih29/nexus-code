import type * as Monaco from "monaco-editor";
import {
  THEME_SOURCES,
  THEME_SOURCE_BY_ID,
  type ThemeId,
} from "../../../../shared/design-tokens";
import { EDITOR_PALETTES, type EditorPalette } from "../../../../shared/editor/palette";
import { buildEffectiveEditorFont } from "../../../hooks/use-effective-editor-font";
import { EDITOR_FONT_EVENT, useEditorFontStore } from "../../../state/stores/editor-font";

// ---------------------------------------------------------------------------
// Monaco theme name registry
//
// Each ThemeId maps to a Monaco theme name string. Monaco's theme names are
// global strings; we namespace them as "nexus-<theme-id>".
// Derived from THEME_SOURCES so adding a theme auto-extends the registry.
// ---------------------------------------------------------------------------

export const NEXUS_THEME_NAMES: Record<ThemeId, string> = Object.fromEntries(
  THEME_SOURCES.map((source) => [source.id, `nexus-${source.id}`]),
) as Record<ThemeId, string>;

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
    // ---------------------------------------------------------------------------
    // Monarch token types (emitted by Monaco's bundled TS/JS/JSON/HTML/CSS grammars)
    // ---------------------------------------------------------------------------
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
    // ---------------------------------------------------------------------------
    // Semantic token types (design.md §15.1, LSP 3.16 standard names).
    // Monaco's standalone editor colours semantic tokens via the same `rules`
    // array as Monarch, matching by **exact token-type name** from the provider
    // legend. Monaco does NOT do prefix matching across unrelated names — the
    // "type" Monarch rule above does NOT match a `class` semantic token; the
    // legend name must appear verbatim as a `token` key. Every canonical
    // CANONICAL_TOKEN_TYPES entry needs an explicit rule below to receive a
    // colour, or it falls back to Monarch's underlying token (or default fg).
    //
    // Legend → palette mapping (frozen §15.1 role set):
    //   class / enum / interface / struct / typeParameter → syntaxType
    //   property / enumMember → syntaxProperty
    //   method                → syntaxFunction  (same callable concept)
    //   parameter             → syntaxVariable  (same as variable)
    //   modifier              → syntaxKeyword   (same as keyword)
    //   macro                 → syntaxFunction  (callable; folded)
    //   event                 → syntaxVariable  (runtime value; folded)
    //   decorator             → syntaxKeyword   (meta/annotation; folded)
    //   label                 → syntaxVariable  (identifier-like; folded)
    // ---------------------------------------------------------------------------
    { token: "class", foreground: fg(palette.syntaxType) },
    { token: "enum", foreground: fg(palette.syntaxType) },
    { token: "interface", foreground: fg(palette.syntaxType) },
    { token: "struct", foreground: fg(palette.syntaxType) },
    { token: "typeParameter", foreground: fg(palette.syntaxType) },
    { token: "property", foreground: fg(palette.syntaxProperty) },
    { token: "enumMember", foreground: fg(palette.syntaxProperty) },
    { token: "method", foreground: fg(palette.syntaxFunction) },
    { token: "parameter", foreground: fg(palette.syntaxVariable) },
    { token: "modifier", foreground: fg(palette.syntaxKeyword) },
    { token: "macro", foreground: fg(palette.syntaxFunction) },
    { token: "event", foreground: fg(palette.syntaxVariable) },
    { token: "decorator", foreground: fg(palette.syntaxKeyword) },
    { token: "label", foreground: fg(palette.syntaxVariable) },
    // ---------------------------------------------------------------------------
    // Pyright extensions — pyright emits custom token types beyond LSP 3.16
    // (declared in CANONICAL_TOKEN_TYPES so they survive remap). Without these
    // rules, references to stdlib functions (`os.getenv`, `print`) and built-in
    // constants (`True`, `None`) render without semantic colour.
    // ---------------------------------------------------------------------------
    { token: "intrinsic", foreground: fg(palette.syntaxFunction) },
    { token: "magicFunction", foreground: fg(palette.syntaxFunction) },
    { token: "builtinConstant", foreground: fg(palette.syntaxKeyword) },
    { token: "selfParameter", foreground: fg(palette.syntaxVariable), fontStyle: "italic" },
    { token: "clsParameter", foreground: fg(palette.syntaxVariable), fontStyle: "italic" },
  ];
}

// ---------------------------------------------------------------------------
// Theme base: light themes use "vs"; dark themes use "vs-dark".
// This ensures Monaco's built-in token colorization starts from the right
// luminance baseline before our palette overrides apply.
//
// Driven by ThemeSource.base metadata so the function does not need a
// per-theme `if` branch when new themes land.
// ---------------------------------------------------------------------------

function monacoBase(themeId: ThemeId): Monaco.editor.BuiltinTheme {
  return THEME_SOURCE_BY_ID[themeId].base === "light" ? "vs" : "vs-dark";
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
    // Note: enabling LSP semantic tokens is done via the editor option
    // `'semanticHighlighting.enabled': true` (see editor-view.tsx), NOT
    // via a theme property — Monaco's IStandaloneThemeData has no
    // `semanticHighlighting` field, so any attempt to set it on
    // defineTheme is silently dropped. The theme just needs to define
    // rules whose `token` names match the semantic-token legend entries
    // (CANONICAL_TOKEN_TYPES in shared/lsp/semantic-tokens.ts).
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

// ---------------------------------------------------------------------------
// subscribeMonacoEditorFontChanges — attach a documentElement listener for the
// nexus:editor-font-changed CustomEvent dispatched by useEditorFontStore setters.
//
// On each event the handler reads the current store state (no React subscription),
// synthesizes the effective font options via buildEffectiveEditorFont, and calls
// updateOptions() on every live Monaco editor instance via getEditors().
//
// Monaco instance refs are NOT stored here — getEditors() provides the live list.
//
// Returns a cleanup function (for test teardown; not needed in prod because
// the listener persists for the app's lifetime).
// ---------------------------------------------------------------------------

export function subscribeMonacoEditorFontChanges(monaco: typeof Monaco): () => void {
  const handler = () => {
    const { size, family, ligatures, lineHeight } = useEditorFontStore.getState();
    const opts = buildEffectiveEditorFont({ size, family, ligatures, lineHeight });
    for (const editor of monaco.editor.getEditors()) {
      editor.updateOptions({
        fontSize: opts.fontSize,
        fontFamily: opts.fontFamily,
        fontLigatures: opts.fontLigatures,
        lineHeight: opts.lineHeight,
      });
    }
  };

  document.documentElement.addEventListener(EDITOR_FONT_EVENT, handler);
  return () => {
    document.documentElement.removeEventListener(EDITOR_FONT_EVENT, handler);
  };
}
