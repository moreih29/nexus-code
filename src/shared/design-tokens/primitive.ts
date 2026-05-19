// primitive.ts — Raw immutable scale values.
// No semantic meaning assigned here; no shadcn variables; no theme-specific values.
// Consumers: semantic.ts (key contract), themes/*.ts (fill values), generate-theme-css.ts.
//
// Authoritative source: .nexus/context/design.md §3 (spacing), §4 (radius).

// ---------------------------------------------------------------------------
// Color palette — OKLCH (converted from hex via culori for perceptual accuracy)
// Translucent colors remain as rgba() since OKLCH does not express alpha in
// the @theme {} block without oklch(…) / alpha hack.
// ---------------------------------------------------------------------------

export const color = {
  // Primary
  warmParchment: "oklch(0.982 0.0041 91.45)",
  earthGray: "oklch(0.3286 0.0017 106.49)",
  // Secondary / accent
  stoneGray: "oklch(0.6173 0.0019 67.79)",
  ashGray: "oklch(0.751 0.0031 84.56)",
  mutedPurple: "oklch(0.5067 0.0082 304.11)",
  darkCharcoal: "oklch(0.3904 0 0)",
  // Canvas — kept as hex because xterm.js Terminal theme.background API
  // accepts only string color literals (no CSS var resolution at runtime).
  bgCanvas: "#1a1917",
  // Hex twin of ashGray — kept as hex for native-widget APIs that don't
  // parse OKLCH (Electron BrowserWindow.titleBarOverlay.symbolColor, etc.).
  // Source of truth: design.md "Ash Gray (#afaeac)".
  ashGrayHex: "#afaeac",
  // Hex twin of warmParchment — kept for direct DOM-style fallbacks (e.g.
  // imperative drag-image labels) that need a literal value when CSS
  // variable resolution may not be guaranteed.
  // Source of truth: design.md "Warm Parchment (#faf9f6)".
  warmParchmentHex: "#faf9f6",
  // Default border for non-CSS-variable contexts. Matches the --border
  // semantic token below (rgba 0.15) — kept here so direct DOM styles
  // can use the same value without depending on CSS variable resolution.
  borderDefault: "rgba(226, 226, 226, 0.15)",
  // Muted surface — shared by sidebar, tab bar, and the custom titlebar so
  // the chrome reads as one continuous "L-shape" against the canvas. Same
  // value drives the --muted / --card / --popover / --secondary semantic
  // tokens below. Hex (not OKLCH) because Electron titleBarOverlay.color
  // also consumes this literal.
  mutedSurfaceHex: "#252422",
  // Surfaces — keep as rgba; alpha is load-bearing.
  // Frosted veil tiers: 0.04 (subtle hover/active bg) → 0.1 (stronger hover)
  // frostedTag/frostedTagHover removed (task 20): marketing remnants, no code callers.
  frostedVeil: "rgba(255, 255, 255, 0.04)",
  frostedVeilStrong: "rgba(255, 255, 255, 0.1)",
  mistBorder: "rgba(226, 226, 226, 0.35)",
  mistBorderFocus: "rgba(226, 226, 226, 0.6)",
  splitter: "rgba(226, 226, 226, 0.35)",
  splitterHover: "rgba(226, 226, 226, 0.6)",
  translucentParchment: "rgba(250, 249, 246, 0.9)",
  // Depth / elevation
  ambientShadow: "rgba(0, 0, 0, 0.2)",
} as const;

// ---------------------------------------------------------------------------
// Font families — authoritative source: ./fonts.ts
// Re-exported here so primitive.ts is the single import point for themes.
// ---------------------------------------------------------------------------

export { fontFamily } from "./fonts";

// ---------------------------------------------------------------------------
// Spacing scale (px) — design.md §3 (4pt grid, 8 canonical steps)
// The full list also includes legacy marketing/spacing values still needed
// by generate-theme-css.ts until marketing scale is removed from the CSS output.
// ---------------------------------------------------------------------------

export const spacing = [1, 4, 5, 8, 10, 12, 14, 15, 16, 18, 24, 26, 30, 32, 36] as const;

// ---------------------------------------------------------------------------
// In-app spacing — design.md §3. 4px base grid plus the Islands `6` step
// (island gap). Replaces the v2 strict-4pt 8-step list.
// ---------------------------------------------------------------------------

export const spacingInApp = [2, 4, 6, 8, 12, 16, 24, 32, 48] as const;

// ---------------------------------------------------------------------------
// Border radius — design.md §4: 5-step Islands radius scale.
//   none(0) / control(4) / raised(6) / island(10) / full
// `island` is the rounded-rect radius for islands AND floating surfaces.
// compact density shrinks `island` to 8px (see islandGeometry below).
// ---------------------------------------------------------------------------

export const radiusScale = {
  none: 0,
  control: 4,
  raised: 6,
  island: 10,
  full: 9999,
} as const;

// ---------------------------------------------------------------------------
// Islands geometry — design.md §3. Fixed, grid-independent constants.
// Two density modes; `compact` shrinks the island gap and island radius.
//
// generate-theme-css.ts が正本（authoritative source）として参照する:
//   v1: --island-gap (gap / gapCompact) + --radius-island (radius / radiusCompact)
//         → :root と :root[data-density='compact'] の両ブロックに emit される.
//   v2: --control-h (buttonHeight / buttonHeightCompact / inputHeight /
//         inputHeightCompact) — v1 スコープ外. v2 で emit 予定.
//
// NOTE: islandGeometry は以前 "dead constant"（定義のみで emit なし）だった.
//   generate-theme-css.ts の emitDensityOverrideBlock() により解消済み.
// ---------------------------------------------------------------------------

export const islandGeometry = {
  gap: 6,
  gapCompact: 4,
  radius: 10,
  radiusCompact: 8,
  buttonHeight: 28,
  buttonHeightCompact: 24,
  buttonMinWidth: 72,
  inputHeight: 28,
  inputHeightCompact: 24,
} as const;

// ---------------------------------------------------------------------------
// Legacy radius map — retained for generate-theme-css.ts backward compat.
// These names drove the old @theme --radius-* tokens; kept to avoid diff in
// CSS output during stage 1 (structure-only change, zero visual regression).
// ---------------------------------------------------------------------------

export const borderRadius = {
  xs: 4,
  sm: 5,
  md: 6,
  card: 8,
  video: 10,
  featureCard: 12,
  largeCard: 14,
  largeSection: 40,
  pill: 50,
  progressBar: 200,
} as const;

// ---------------------------------------------------------------------------
// Breakpoints (px)
// ---------------------------------------------------------------------------

export const breakpoint = {
  mobile: 810,
  tablet: 1500,
} as const;
