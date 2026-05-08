// Editor color palette — source of truth for Monaco editor token colors.
//
// Mirrors the design-tokens-marketing.ts / design-tokens-fonts.ts split
// convention: editor-specific color tiers live here so design-tokens.ts
// stays focused on the application chrome (semantic CSS vars, spacing, radius).
//
// Consumed by: src/renderer/services/editor/monaco-theme.ts
//
// Format constraint: ALL values MUST be hex literals (#rrggbb or #rrggbbaa)
// or "transparent" expressed as #00000000. Monaco's standalone theme color
// parser silently rejects rgba()/rgb()/hsl()/named-color forms in
// `editor.defineTheme({ colors })` and falls back to a #ff0000 sentinel,
// which is what produced the bright-red find/peek/selection highlights
// after the initial Plan #22 ship. This palette is therefore deliberately
// out of sync with design-tokens.ts's rgba() representations of the same
// colors — the tokens.ts shape is correct for CSS, the editor-palette
// shape is correct for monaco. The intent (warm parchment alpha tiers)
// is the same.
//
// Alpha conversion reference (alpha * 255 → 8-digit hex pair):
//   0.04 → 0a   0.05 → 0d   0.06 → 0f   0.08 → 14
//   0.10 → 1a   0.12 → 1f   0.15 → 26   0.16 → 29
//   0.20 → 33   0.50 → 80   0.60 → 99   0.75 → bf
//
// warmParchment(rgba 250,249,246) → #faf9f6
// pureWhite(rgba 255,255,255)     → #ffffff
// mistGray(rgba 226,226,226)      → #e2e2e2
// ashGray(rgba 175,174,172)       → #afaeac

export interface EditorPalette {
  // word highlight
  wordHighlightBackground: string;
  wordHighlightStrongBackground: string;
  wordHighlightTextBackground: string;
  // find/match
  findRangeHighlightBackground: string;
  findMatchHighlightBackground: string;
  findMatchBackground: string;
  // peek
  peekViewBorder: string;
  peekViewEditorMatchHighlightBackground: string;
  peekViewResultMatchHighlightBackground: string;
  peekViewResultBackground: string;
  // link
  linkForeground: string;
  linkActiveForeground: string;
  // selection
  selectionBackground: string;
  inactiveSelectionBackground: string;
  selectionHighlightBackground: string;
  // widget surfaces
  hoverWidgetBackground: string;
  hoverWidgetBorder: string;
  editorWidgetBackground: string;
  editorWidgetBorder: string;
  // diagnostic
  errorForeground: string;
  warningForeground: string;
  infoForeground: string;
  hintForeground: string;
  errorBackground: string;
  warningBackground: string;
  infoBackground: string;
  hintBackground: string;
}

export const nexusDarkPalette: EditorPalette = {
  // word highlight — warmParchment alpha tier (text 0.04 / occurrence 0.06 / strong 0.12)
  wordHighlightBackground: "#faf9f60f", // warmParchment α 0.06
  wordHighlightStrongBackground: "#faf9f61f", // warmParchment α 0.12
  wordHighlightTextBackground: "#faf9f60a", // warmParchment α 0.04
  // find/match
  findRangeHighlightBackground: "#ffffff0a", // frostedVeil (white α 0.04)
  findMatchHighlightBackground: "#faf9f60f", // warmParchment α 0.06
  findMatchBackground: "#faf9f633", // warmParchment α 0.20
  // peek
  peekViewBorder: "#e2e2e299", // mistBorderFocus (rgba 226,226,226 α 0.6)
  peekViewEditorMatchHighlightBackground: "#faf9f633", // warmParchment α 0.20
  peekViewResultMatchHighlightBackground: "#faf9f61f", // warmParchment α 0.12
  peekViewResultBackground: "#252422", // mutedSurfaceHex
  // link
  linkForeground: "#afaeac", // ashGrayHex
  linkActiveForeground: "#faf9f6", // warmParchmentHex
  // selection
  selectionBackground: "#faf9f629", // warmParchment α 0.16
  inactiveSelectionBackground: "#ffffff1a", // frostedVeilStrong (white α 0.10)
  selectionHighlightBackground: "#faf9f60f", // warmParchment α 0.06
  // widget surfaces
  hoverWidgetBackground: "#252422", // mutedSurfaceHex
  hoverWidgetBorder: "#e2e2e226", // borderDefault (rgba 226,226,226 α 0.15)
  editorWidgetBackground: "#252422", // mutedSurfaceHex
  editorWidgetBorder: "#e2e2e299", // mistBorderFocus
  // diagnostic — s2 dual-axis (alpha differentiates severity, monaco draws
  // wavy/dotted underline based on monaco's own diagnostic kind)
  errorForeground: "#faf9f6", // warmParchment α 1.0
  warningForeground: "#faf9f6bf", // warmParchment α 0.75
  infoForeground: "#868584", // stoneGray hex twin
  hintForeground: "#afaeac80", // ashGray α 0.5
  errorBackground: "#faf9f614", // warmParchment α 0.08
  warningBackground: "#faf9f60d", // warmParchment α 0.05
  infoBackground: "#00000000", // transparent (8-digit hex form for monaco compatibility)
  hintBackground: "#00000000", // transparent
};
