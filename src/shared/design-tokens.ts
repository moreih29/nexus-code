// Design tokens for the application chrome.
//
// Update policy:
//   1. Color palette + spacing + radius + breakpoints  → in sync with
//      `.nexus/context/design.md`. Update both at the same time.
//   2. typeScale (codeUi / codeBody)                   → consumed by
//      Monaco / xterm directly via JS import; not part of design.md.
//   3. appTypeScale                                    → Designer Q1
//      guidance, independent source of truth for in-app UI components.
//   4. Marketing scale (18 roles)                      → lives in
//      `./design-tokens-marketing.ts` so updates to design.md don't
//      have to scroll past the chrome tokens. Re-imported here only
//      for the public `typeScale` export so existing consumers keep
//      working.

// ---------------------------------------------------------------------------
// Color palette — OKLCH (converted from hex via culori for perceptual accuracy)
// Translucent colors remain as rgba() since OKLCH does not express alpha in
// the @theme {} block without oklch(...) / alpha hack.
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
  // Frosted veil tiers: 0.04 (subtle hover/active bg) → 0.1 (stronger hover) → 0.16 (frosted tag) → 0.24 (tag hover)
  frostedVeil: "rgba(255, 255, 255, 0.04)",
  frostedVeilStrong: "rgba(255, 255, 255, 0.1)",
  frostedTag: "rgba(255, 255, 255, 0.16)",
  frostedTagHover: "rgba(255, 255, 255, 0.24)",
  mistBorder: "rgba(226, 226, 226, 0.35)",
  mistBorderFocus: "rgba(226, 226, 226, 0.6)",
  splitter: "rgba(226, 226, 226, 0.35)",
  splitterHover: "rgba(226, 226, 226, 0.6)",
  // Word-highlight tiers for Monaco editor: base warmParchment (rgba 250,249,246),
  // alpha 0.04 (text / near-invisible mark) → 0.06 (subtle occurrence bg) → 0.12 (strong/definition bg)
  editorWordHighlight: "rgba(250, 249, 246, 0.06)",
  editorWordHighlightStrong: "rgba(250, 249, 246, 0.12)",
  editorWordHighlightText: "rgba(250, 249, 246, 0.04)",
  translucentParchment: "rgba(250, 249, 246, 0.9)",
  // Depth / elevation
  ambientShadow: "rgba(0, 0, 0, 0.2)",
} as const;

// ---------------------------------------------------------------------------
// Semantic token map — shadcn convention variables
// --primary        = earthGray    (봉인)
// --accent         = ashGray      (봉인)
// --shadow-*       = none         (봉인)
// --radius         = 0            (봉인)
// ---------------------------------------------------------------------------

export function buildSemanticTokens(): Record<string, string> {
  return {
    // Canvas / page background
    "--background": color.bgCanvas,
    "--foreground": color.warmParchment,
    // Muted surfaces (sidebar, tab bar, titlebar)
    "--muted": color.mutedSurfaceHex,
    "--muted-foreground": color.stoneGray,
    // Card surfaces
    "--card": color.mutedSurfaceHex,
    "--card-foreground": color.warmParchment,
    // Popover
    "--popover": color.mutedSurfaceHex,
    "--popover-foreground": color.warmParchment,
    // Primary action (earthGray —봉인)
    "--primary": color.earthGray,
    "--primary-foreground": color.warmParchment,
    // Secondary
    "--secondary": color.mutedSurfaceHex,
    "--secondary-foreground": color.warmParchment,
    // Accent (ashGray — 봉인)
    "--accent": color.ashGray,
    "--accent-foreground": color.earthGray,
    // Destructive
    "--destructive": "oklch(0.577 0.245 27.33)",
    "--destructive-foreground": color.warmParchment,
    // Border / input / ring
    "--border": "rgba(226, 226, 226, 0.15)",
    "--input": "rgba(226, 226, 226, 0.15)",
    "--ring": color.ashGray,
    // Layout — radius 0 봉인, shadow none 봉인
    "--radius": "0px",
    "--shadow-sm": "none",
    "--shadow": "none",
    "--shadow-md": "none",
    "--shadow-lg": "none",
    "--shadow-xl": "none",
    "--shadow-2xl": "none",
    // Splitter
    "--splitter": color.splitter,
    "--splitter-hover": color.splitterHover,
    // Motion
    "--motion-fade": "220ms ease",
  };
}

// ---------------------------------------------------------------------------
// Typography — font families. Authoritative source: `./design-tokens-fonts.ts`
// (lifted out so the marketing scale and the in-app code scale can both
// import it without forming a circular dependency through this module).
// ---------------------------------------------------------------------------

export { fontFamily } from "./design-tokens-fonts";

import { fontFamily } from "./design-tokens-fonts";

// ---------------------------------------------------------------------------
// Code type scale — consumed by Monaco / xterm directly.
// fontSize and letterSpacing are in px; lineHeight is unitless ratio.
// ---------------------------------------------------------------------------

const codeTypeScale = {
  codeUi: {
    fontFamily: fontFamily.monoDisplay,
    fontSize: 16,
    fontWeight: 400,
    lineHeight: 1.0,
    letterSpacing: 0,
  },
  codeBody: {
    fontFamily: fontFamily.monoBody,
    fontSize: 16,
    fontWeight: 400,
    lineHeight: 1.0,
    letterSpacing: -0.2,
  },
} as const;

// ---------------------------------------------------------------------------
// Public typeScale — composes the marketing 18-role scale (separate file)
// with the in-app code roles. Public surface is unchanged so existing
// consumers (cn.ts, generator, EditorView, TerminalView) keep working.
// ---------------------------------------------------------------------------

import { marketingTypeScale } from "./design-tokens-marketing";

export const typeScale = {
  ...marketingTypeScale,
  ...codeTypeScale,
} as const;

// ---------------------------------------------------------------------------
// Application-UI type scale — Designer Q1 guidance. micro (11px / 1.2 / 0)
// already lives in marketing typeScale, so it is not duplicated here.
// fontSize and letterSpacing are in px; lineHeight is unitless ratio.
// ---------------------------------------------------------------------------

export const appTypeScale = {
  appBody: {
    fontFamily: fontFamily.display,
    fontSize: 13,
    fontWeight: 400,
    lineHeight: 1.4,
    letterSpacing: 0,
  },
  appBodyEmphasis: {
    fontFamily: fontFamily.display,
    fontSize: 14,
    fontWeight: 400,
    lineHeight: 1.3,
    letterSpacing: 0,
  },
  appUiSm: {
    fontFamily: fontFamily.display,
    fontSize: 12,
    fontWeight: 400,
    lineHeight: 1.5,
    letterSpacing: 0,
  },
  appUiXs: {
    fontFamily: fontFamily.display,
    fontSize: 12,
    fontWeight: 400,
    lineHeight: 1.35,
    letterSpacing: 2.4,
  },
} as const;

// ---------------------------------------------------------------------------
// Spacing scale (px)
// ---------------------------------------------------------------------------

export const spacing = [1, 4, 5, 8, 10, 12, 14, 15, 16, 18, 24, 26, 30, 32, 36] as const;

export type SpacingValue = (typeof spacing)[number];

// ---------------------------------------------------------------------------
// Border radius scale (px)
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

// Inclusive ranges for convenience:
// mobile:  width < breakpoint.mobile
// tablet:  breakpoint.mobile <= width <= breakpoint.tablet
// desktop: width > breakpoint.tablet
