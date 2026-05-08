// Editor color palette — source of truth for Monaco editor token colors.
//
// Mirrors the design-tokens-marketing.ts / design-tokens-fonts.ts split
// convention: editor-specific color tiers live here so design-tokens.ts
// stays focused on the application chrome (semantic CSS vars, spacing, radius).
//
// Consumed by: src/renderer/services/editor/monaco-theme.ts
// Update policy: alpha tiers for warmParchment (rgba 250,249,246) are defined
// as inline literals here — this palette IS the SoT for editor-specific tiers.
// Do NOT add new editor color values to the `color` const in design-tokens.ts.

import { color } from "./design-tokens";

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
  // word highlight (migrated from design-tokens.ts color.editorWordHighlight*)
  wordHighlightBackground: "rgba(250, 249, 246, 0.06)",
  wordHighlightStrongBackground: "rgba(250, 249, 246, 0.12)",
  wordHighlightTextBackground: "rgba(250, 249, 246, 0.04)",
  // find/match
  findRangeHighlightBackground: color.frostedVeil,
  findMatchHighlightBackground: "rgba(250, 249, 246, 0.06)",
  findMatchBackground: "rgba(250, 249, 246, 0.20)",
  // peek
  peekViewBorder: color.mistBorderFocus,
  peekViewEditorMatchHighlightBackground: "rgba(250, 249, 246, 0.20)",
  peekViewResultMatchHighlightBackground: "rgba(250, 249, 246, 0.12)",
  peekViewResultBackground: color.mutedSurfaceHex,
  // link
  linkForeground: color.ashGrayHex,
  linkActiveForeground: color.warmParchmentHex,
  // selection
  selectionBackground: "rgba(250, 249, 246, 0.16)",
  inactiveSelectionBackground: color.frostedVeilStrong,
  selectionHighlightBackground: "rgba(250, 249, 246, 0.06)",
  // widget surfaces
  hoverWidgetBackground: color.mutedSurfaceHex,
  hoverWidgetBorder: color.borderDefault,
  editorWidgetBackground: color.mutedSurfaceHex,
  editorWidgetBorder: color.mistBorderFocus,
  // diagnostic
  errorForeground: color.warmParchmentHex,
  warningForeground: "rgba(250, 249, 246, 0.75)",
  infoForeground: "#868584",
  hintForeground: "rgba(175, 174, 172, 0.5)",
  errorBackground: "rgba(250, 249, 246, 0.08)",
  warningBackground: "rgba(250, 249, 246, 0.05)",
  infoBackground: "transparent",
  hintBackground: "transparent",
};
