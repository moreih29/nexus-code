// Editor color palette — source of truth for Monaco editor token colors.
//
// Mirrors the design-tokens-marketing.ts / design-tokens-fonts.ts split
// convention: editor-specific color tiers live here so design-tokens.ts
// stays focused on the application chrome (semantic CSS vars, spacing, radius).
//
// Consumed by: src/renderer/services/editor/runtime/monaco-theme.ts
//
// Format constraint: ALL values MUST be hex literals (#rrggbb or #rrggbbaa)
// or "transparent" expressed as #00000000. Monaco's standalone theme color
// parser silently rejects rgba()/rgb()/hsl()/named-color forms in
// `editor.defineTheme({ colors })` and falls back to a #ff0000 sentinel.
//
// ---------------------------------------------------------------------------
// Conversion boundary
//
// AUTO-CONVERTED (culori formatHex at module load time in monaco-theme.ts):
//   Plain OKLCH values from themes/*.ts that have no alpha component.
//   Example: oklch(0.982 0.0041 91.45) → #faf9f6
//
// MANUAL (explicit 8-digit hex literals in this file):
//   All alpha-composited colors where the alpha value carries semantic meaning
//   (hover/selection tier, diagnostic severity tier, frosted surface tier).
//   These cannot be auto-converted because culori formatHex8 on a bare OKLCH
//   color produces full-opacity hex — the alpha fraction is the intent.
//   The manual boundary is: anything that appears as rgba(r,g,b,a) in
//   design-tokens/primitive.ts or themes/*.ts.
//
// Alpha conversion reference (alpha * 255, rounded → 2-digit hex):
//   0.04 → 0a   0.05 → 0d   0.06 → 0f   0.08 → 14
//   0.10 → 1a   0.12 → 1f   0.15 → 26   0.16 → 29
//   0.18 → 2e   0.20 → 33   0.24 → 3d   0.28 → 47
//   0.35 → 59   0.42 → 6b   0.45 → 73   0.50 → 80
//   0.60 → 99   0.75 → bf   1.00 → ff
// ---------------------------------------------------------------------------

import type { ThemeId } from "../design-tokens";

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

// ---------------------------------------------------------------------------
// Warm Dark — hue ~90-110, dark background. Baseline palette (existing).
// Surface hex values auto-derived from OKLCH via culori:
//   oklch(0.982 0.0041 91.45) → #faf9f6  warmParchment (fg)
//   oklch(0.6173 0.0019 67.79) → #868584  stoneGray (muted fg)
//   oklch(0.751 0.0031 84.56) → #afaeac  ashGray (accent)
//   #1a1917 bgCanvas (literal hex, no conversion needed)
//   #252422 mutedSurfaceHex (literal hex, no conversion needed)
// Alpha tiers: MANUAL — rgba() values from primitive.ts converted to 8-digit hex.
// ---------------------------------------------------------------------------

const warmDarkPalette: EditorPalette = {
  // word highlight — warmParchment (#faf9f6) alpha tier [MANUAL]
  wordHighlightBackground: "#faf9f60f", // warmParchment α 0.06
  wordHighlightStrongBackground: "#faf9f61f", // warmParchment α 0.12
  wordHighlightTextBackground: "#faf9f60a", // warmParchment α 0.04
  // find/match [MANUAL]
  findRangeHighlightBackground: "#ffffff0a", // frostedVeil (white α 0.04)
  findMatchHighlightBackground: "#faf9f60f", // warmParchment α 0.06
  findMatchBackground: "#faf9f633", // warmParchment α 0.20
  // peek [AUTO + MANUAL]
  peekViewBorder: "#e2e2e299", // mistBorderFocus (rgba 226,226,226 α 0.6) [MANUAL]
  peekViewEditorMatchHighlightBackground: "#faf9f633", // warmParchment α 0.20 [MANUAL]
  peekViewResultMatchHighlightBackground: "#faf9f61f", // warmParchment α 0.12 [MANUAL]
  peekViewResultBackground: "#252422", // mutedSurfaceHex [AUTO/literal]
  // link [AUTO]
  linkForeground: "#afaeac", // ashGray
  linkActiveForeground: "#faf9f6", // warmParchment
  // selection [MANUAL]
  selectionBackground: "#faf9f629", // warmParchment α 0.16
  inactiveSelectionBackground: "#ffffff1a", // frostedVeilStrong (white α 0.10)
  selectionHighlightBackground: "#faf9f60f", // warmParchment α 0.06
  // widget surfaces [AUTO/literal]
  hoverWidgetBackground: "#252422", // mutedSurfaceHex
  hoverWidgetBorder: "#e2e2e226", // borderDefault (rgba 226,226,226 α 0.15) [MANUAL]
  editorWidgetBackground: "#252422", // mutedSurfaceHex
  editorWidgetBorder: "#e2e2e299", // mistBorderFocus [MANUAL]
  // diagnostic [MANUAL alpha tiers on AUTO base fg]
  errorForeground: "#faf9f6", // warmParchment α 1.0 [AUTO]
  warningForeground: "#faf9f6bf", // warmParchment α 0.75 [MANUAL]
  infoForeground: "#868584", // stoneGray [AUTO]
  hintForeground: "#afaeac80", // ashGray α 0.5 [MANUAL]
  errorBackground: "#faf9f614", // warmParchment α 0.08 [MANUAL]
  warningBackground: "#faf9f60d", // warmParchment α 0.05 [MANUAL]
  infoBackground: "#00000000", // transparent [MANUAL — 8-digit for monaco compat]
  hintBackground: "#00000000", // transparent [MANUAL]
};

// ---------------------------------------------------------------------------
// Cool Dark — hue ~240-250, same lightness as warm-dark (L0 ≈ 0.18).
// Surface hex values auto-derived from OKLCH via culori:
//   oklch(0.18 0.008 245) → #0f1215  canvas bg
//   oklch(0.22 0.007 245) → #181b1e  chrome bg
//   oklch(0.96 0.004 240) → #eff2f4  fg
//   oklch(0.60 0.006 245) → #7d8184  muted fg
//   oklch(0.72 0.006 245) → #a2a5a8  accent/ash
//   oklch(0.32 0.008 245) → #303337  selected bg
// Alpha tiers: MANUAL — cool-tinted white overlay (rgba 200,210,255,a).
// ---------------------------------------------------------------------------

const coolDarkPalette: EditorPalette = {
  // word highlight — cool fg (#eff2f4) alpha tier [MANUAL]
  wordHighlightBackground: "#eff2f40f", // cool fg α 0.06
  wordHighlightStrongBackground: "#eff2f41f", // cool fg α 0.12
  wordHighlightTextBackground: "#eff2f40a", // cool fg α 0.04
  // find/match [MANUAL]
  findRangeHighlightBackground: "#c8d2ff0a", // cool veil (rgba 200,210,255 α 0.04)
  findMatchHighlightBackground: "#eff2f40f", // cool fg α 0.06
  findMatchBackground: "#eff2f433", // cool fg α 0.20
  // peek [MANUAL]
  peekViewBorder: "#c8d2f099", // cool mist border strong (rgba 200,210,240 α 0.6)
  peekViewEditorMatchHighlightBackground: "#eff2f433", // cool fg α 0.20
  peekViewResultMatchHighlightBackground: "#eff2f41f", // cool fg α 0.12
  peekViewResultBackground: "#181b1e", // chrome bg [AUTO]
  // link [AUTO]
  linkForeground: "#a2a5a8", // cool ash
  linkActiveForeground: "#eff2f4", // cool fg
  // selection [MANUAL]
  selectionBackground: "#eff2f429", // cool fg α 0.16
  inactiveSelectionBackground: "#c8d2ff1a", // cool veil α 0.10
  selectionHighlightBackground: "#eff2f40f", // cool fg α 0.06
  // widget surfaces [AUTO]
  hoverWidgetBackground: "#181b1e", // chrome bg
  hoverWidgetBorder: "#c8d2f026", // cool border (rgba 200,210,240 α 0.15) [MANUAL]
  editorWidgetBackground: "#181b1e", // chrome bg
  editorWidgetBorder: "#c8d2f099", // cool border strong [MANUAL]
  // diagnostic [same semantic colors, theme-invariant]
  errorForeground: "#eff2f4", // cool fg α 1.0 [AUTO]
  warningForeground: "#eff2f4bf", // cool fg α 0.75 [MANUAL]
  infoForeground: "#7d8184", // cool muted fg [AUTO]
  hintForeground: "#a2a5a880", // cool ash α 0.5 [MANUAL]
  errorBackground: "#eff2f414", // cool fg α 0.08 [MANUAL]
  warningBackground: "#eff2f40d", // cool fg α 0.05 [MANUAL]
  infoBackground: "#00000000", // transparent [MANUAL]
  hintBackground: "#00000000", // transparent [MANUAL]
};

// ---------------------------------------------------------------------------
// Warm Light — hue ~90-110, light background (L0 ≈ 0.965).
// Surface hex values auto-derived from OKLCH via culori:
//   oklch(0.965 0.005 95) → #f4f3f0  canvas bg
//   oklch(0.935 0.005 95) → #eae9e6  chrome bg
//   oklch(0.22 0.008 100) → #1b1b17  fg (dark on light)
//   oklch(0.50 0.005 95) → #646360  muted fg
//   oklch(0.42 0.008 100) → #4e4d48  ash/accent (dark ring color)
//   oklch(0.3286 0.0017 106.49) → #353534 selected bg (earthGray)
// Alpha tiers: MANUAL — dark overlay direction (rgba 26,25,15,a).
// NOTE: light theme reversal — overlay is dark-direction per design.md §7.
//
// Contrast notes (task 21 verification targets):
//   errorForeground #b70000 (oklch 0.47 0.22 27) on #f4f3f0: ~7:1 (AA pass)
//   warningForeground #905e00 (oklch 0.52 0.14 82) on #f4f3f0: ~4.8:1 (AA pass)
//   infoForeground #646360 (muted) on #f4f3f0: ~4.1:1 (borderline at 12px — task 21)
//   selectionBackground #1b1b1714 (dark α 0.08 on #f4f3f0): visible as subtle tint
//   peekViewBorder uses dark translucent — contrast needs measurement on light
// ---------------------------------------------------------------------------

const warmLightPalette: EditorPalette = {
  // word highlight — dark fg (#1b1b17) alpha tier [MANUAL]
  wordHighlightBackground: "#1b1b170f", // dark fg α 0.06
  wordHighlightStrongBackground: "#1b1b171f", // dark fg α 0.12
  wordHighlightTextBackground: "#1b1b170a", // dark fg α 0.04
  // find/match [MANUAL]
  findRangeHighlightBackground: "#1a190f0a", // dark veil (rgba 26,25,15 α 0.04)
  findMatchHighlightBackground: "#1b1b170f", // dark fg α 0.06
  findMatchBackground: "#1b1b1733", // dark fg α 0.20
  // peek [MANUAL — dark hairlines on light bg]
  peekViewBorder: "#32302699", // dark mist border (rgba 50,48,38 α 0.6)
  peekViewEditorMatchHighlightBackground: "#1b1b1733", // dark fg α 0.20
  peekViewResultMatchHighlightBackground: "#1b1b171f", // dark fg α 0.12
  peekViewResultBackground: "#eae9e6", // chrome bg [AUTO]
  // link [AUTO]
  linkForeground: "#4e4d48", // warm ash (dark)
  linkActiveForeground: "#1b1b17", // dark fg
  // selection [MANUAL — dark overlay for light theme]
  selectionBackground: "#1b1b1729", // dark fg α 0.16
  inactiveSelectionBackground: "#1a190f1a", // dark veil α 0.10
  selectionHighlightBackground: "#1b1b170f", // dark fg α 0.06
  // widget surfaces [AUTO]
  hoverWidgetBackground: "#eae9e6", // chrome bg
  hoverWidgetBorder: "#32302626", // dark border (rgba 50,48,38 α 0.15) [MANUAL]
  editorWidgetBackground: "#eae9e6", // chrome bg
  editorWidgetBorder: "#32302699", // dark border strong [MANUAL]
  // diagnostic — re-tuned for light bg [AUTO from warm-light semantic]
  // oklch(0.47 0.22 27) → #b70000 (≈7:1 on #f4f3f0, WCAG AA)
  errorForeground: "#b70000", // AUTO
  // oklch(0.47 0.22 27) α 0.75 [MANUAL]
  warningForeground: "#905e00bf", // warm-light warning fg (oklch 0.52 0.14 82 → #905e00) α 0.75
  // oklch(0.50 0.005 95) → #646360 muted fg [AUTO]
  infoForeground: "#646360", // AUTO
  // dark ash α 0.5 [MANUAL]
  hintForeground: "#4e4d4880", // warm ash α 0.5
  // dark fg α tiers on light bg [MANUAL]
  errorBackground: "#b7000014", // error color α 0.08
  warningBackground: "#905e000d", // warning color α 0.05
  infoBackground: "#00000000", // transparent [MANUAL]
  hintBackground: "#00000000", // transparent [MANUAL]
};

// ---------------------------------------------------------------------------
// Backward-compat export — consumed by monaco-theme.ts before multi-theme era.
// Kept to avoid churn on existing callers; new code uses EDITOR_PALETTES map.
// ---------------------------------------------------------------------------
export const nexusDarkPalette: EditorPalette = warmDarkPalette;

// ---------------------------------------------------------------------------
// Multi-theme palette registry
// ---------------------------------------------------------------------------
export const EDITOR_PALETTES: Record<ThemeId, EditorPalette> = {
  "warm-dark": warmDarkPalette,
  "cool-dark": coolDarkPalette,
  "warm-light": warmLightPalette,
};
