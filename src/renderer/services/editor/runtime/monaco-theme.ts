import type * as Monaco from "monaco-editor";
import { type EditorPalette, nexusDarkPalette } from "../../../../shared/editor/palette";

export const NEXUS_DARK_THEME_NAME = "nexus-dark";

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

const initializedThemeMonacos = new WeakSet<object>();

export function initializeMonacoTheme(monaco: typeof Monaco): void {
  if (initializedThemeMonacos.has(monaco)) return;
  monaco.editor.defineTheme(NEXUS_DARK_THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: buildEditorColors(nexusDarkPalette),
  });
  initializedThemeMonacos.add(monaco);
}
