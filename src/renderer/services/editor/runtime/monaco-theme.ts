import type * as Monaco from "monaco-editor";
import { THEME_SOURCE_BY_ID, THEME_SOURCES, type ThemeId } from "../../../../shared/design-tokens";
import { EDITOR_PALETTES, type EditorPalette } from "../../../../shared/editor/palette";
import { buildEffectiveEditorFont } from "../../../hooks/use-effective-editor-font";
import { EDITOR_FONT_EVENT, useEditorFontStore } from "../../../state/stores/editor-font";

export const NEXUS_THEME_NAMES: Record<ThemeId, string> = Object.fromEntries(
  THEME_SOURCES.map((source) => [source.id, `nexus-${source.id}`]),
) as Record<ThemeId, string>;

export function buildEditorColors(palette: EditorPalette): Monaco.editor.IColors {
  return {
    "editor.wordHighlightBackground": palette.wordHighlightBackground,
    "editor.wordHighlightStrongBackground": palette.wordHighlightStrongBackground,
    "editor.wordHighlightTextBackground": palette.wordHighlightTextBackground,
    "editor.findRangeHighlightBackground": palette.findRangeHighlightBackground,
    "editor.findMatchHighlightBackground": palette.findMatchHighlightBackground,
    "editor.findMatchBackground": palette.findMatchBackground,
    "peekView.border": palette.peekViewBorder,
    "peekViewEditor.matchHighlightBackground": palette.peekViewEditorMatchHighlightBackground,
    "peekViewResult.matchHighlightBackground": palette.peekViewResultMatchHighlightBackground,
    "peekViewResult.background": palette.peekViewResultBackground,
    "editorLink.activeForeground": palette.linkActiveForeground,
    "editor.selectionBackground": palette.selectionBackground,
    "editor.inactiveSelectionBackground": palette.inactiveSelectionBackground,
    "editor.selectionHighlightBackground": palette.selectionHighlightBackground,
    "editorHoverWidget.background": palette.hoverWidgetBackground,
    "editorHoverWidget.border": palette.hoverWidgetBorder,
    "editorWidget.background": palette.editorWidgetBackground,
    "editorWidget.border": palette.editorWidgetBorder,
    "editorError.foreground": palette.errorForeground,
    "editorWarning.foreground": palette.warningForeground,
    "editorInfo.foreground": palette.infoForeground,
    "editorHint.foreground": palette.hintForeground,
    "editorError.background": palette.errorBackground,
    "editorWarning.background": palette.warningBackground,
    "editorInfo.background": palette.infoBackground,
    "editorHint.background": palette.hintBackground,
    "editor.background": palette.editorBackground,
    "editorGutter.background": palette.editorBackground,
  };
}

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
    { token: "intrinsic", foreground: fg(palette.syntaxFunction) },
    { token: "magicFunction", foreground: fg(palette.syntaxFunction) },
    { token: "builtinConstant", foreground: fg(palette.syntaxKeyword) },
    { token: "selfParameter", foreground: fg(palette.syntaxVariable), fontStyle: "italic" },
    { token: "clsParameter", foreground: fg(palette.syntaxVariable), fontStyle: "italic" },
  ];
}

function monacoBase(themeId: ThemeId): Monaco.editor.BuiltinTheme {
  return THEME_SOURCE_BY_ID[themeId].base === "light" ? "vs" : "vs-dark";
}

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

  subscribeMonacoThemeChanges(monaco);
}

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

  const onFontsLoaded = (event: FontFaceSetLoadEvent) => {
    if (event.fontfaces.some((face) => face.family.replaceAll('"', "") === "Sarasa Term K")) {
      monaco.editor.remeasureFonts();
    }
  };

  document.documentElement.addEventListener(EDITOR_FONT_EVENT, handler);
  document.fonts.addEventListener("loadingdone", onFontsLoaded);
  return () => {
    document.documentElement.removeEventListener(EDITOR_FONT_EVENT, handler);
    document.fonts.removeEventListener("loadingdone", onFontsLoaded);
  };
}
