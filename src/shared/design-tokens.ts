// TODO: Keep this file in sync with .nexus/context/design.md.
// When design.md is updated, review and update the token values below accordingly.

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
  // Surfaces — keep as rgba; alpha is load-bearing.
  // Frosted veil tiers: 0.04 (subtle hover/active bg) → 0.1 (stronger hover) → 0.16 (frosted tag) → 0.24 (tag hover)
  frostedVeil: "rgba(255, 255, 255, 0.04)",
  frostedVeilStrong: "rgba(255, 255, 255, 0.1)",
  frostedTag: "rgba(255, 255, 255, 0.16)",
  frostedTagHover: "rgba(255, 255, 255, 0.24)",
  mistBorder: "rgba(226, 226, 226, 0.35)",
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
    // Muted surfaces (sidebar, tab bar)
    "--muted": "#252422",
    "--muted-foreground": color.stoneGray,
    // Card surfaces
    "--card": "#252422",
    "--card-foreground": color.warmParchment,
    // Popover
    "--popover": "#252422",
    "--popover-foreground": color.warmParchment,
    // Primary action (earthGray —봉인)
    "--primary": color.earthGray,
    "--primary-foreground": color.warmParchment,
    // Secondary
    "--secondary": "#252422",
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
    // Motion
    "--motion-fade": "220ms ease",
  };
}

// ---------------------------------------------------------------------------
// Typography — font families (M1: Matter → Pretendard; mono → JetBrains Mono)
// ---------------------------------------------------------------------------

export const fontFamily = {
  // Tailwind utility overrides — font-sans / font-mono map to these
  sans: "Pretendard, system-ui, -apple-system, sans-serif",
  mono: `"JetBrains Mono Nerd Font", "Sarasa Term K", ui-monospace, monospace`,
  // display/body/caption roles → Pretendard (han-first, M1)
  display: "Pretendard, system-ui, -apple-system, sans-serif",
  // medium/square/uiSupplement: Pretendard placeholder (revisit when assets arrive)
  medium: "Pretendard, system-ui, -apple-system, sans-serif",
  square: "Pretendard, system-ui, -apple-system, sans-serif",
  uiSupplement: "Pretendard, system-ui, -apple-system, sans-serif",
  // mono roles → JetBrains Mono Nerd Font + Sarasa Term K fallback
  monoDisplay: `"JetBrains Mono Nerd Font", "Sarasa Term K", ui-monospace, monospace`,
  monoBody: `"JetBrains Mono Nerd Font", "Sarasa Term K", ui-monospace, monospace`,
} as const;

// ---------------------------------------------------------------------------
// Typography — hierarchy
// Role → { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing }
// fontSize and letterSpacing are in px; lineHeight is unitless ratio.
// ---------------------------------------------------------------------------

export const typeScale = {
  displayHero: {
    fontFamily: fontFamily.display,
    fontSize: 80,
    fontWeight: 400,
    lineHeight: 1.0,
    letterSpacing: -2.4,
  },
  sectionDisplay: {
    fontFamily: fontFamily.display,
    fontSize: 56,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: -0.56,
  },
  sectionHeading: {
    fontFamily: fontFamily.display,
    fontSize: 48,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: -0.48,
  },
  featureHeading: {
    fontFamily: fontFamily.display,
    fontSize: 40,
    fontWeight: 400,
    lineHeight: 1.1,
    letterSpacing: -0.4,
  },
  subHeadingLarge: {
    fontFamily: fontFamily.display,
    fontSize: 36,
    fontWeight: 400,
    lineHeight: 1.15,
    letterSpacing: -0.72,
  },
  cardDisplay: {
    fontFamily: fontFamily.square,
    fontSize: 42,
    fontWeight: 400,
    lineHeight: 1.0,
    letterSpacing: 0,
  },
  subHeading: {
    fontFamily: fontFamily.display,
    fontSize: 32,
    fontWeight: 400,
    lineHeight: 1.19,
    letterSpacing: 0,
  },
  bodyHeading: {
    fontFamily: fontFamily.display,
    fontSize: 24,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: -0.72,
  },
  cardTitle: {
    fontFamily: fontFamily.medium,
    fontSize: 22,
    fontWeight: 500,
    lineHeight: 1.14,
    letterSpacing: 0,
  },
  bodyLarge: {
    fontFamily: fontFamily.display,
    fontSize: 20,
    fontWeight: 400,
    lineHeight: 1.4,
    letterSpacing: -0.2,
  },
  body: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    fontWeight: 400,
    lineHeight: 1.3,
    letterSpacing: -0.18,
  },
  navUi: {
    fontFamily: fontFamily.display,
    fontSize: 16,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: 0,
  },
  buttonText: {
    fontFamily: fontFamily.medium,
    fontSize: 16,
    fontWeight: 500,
    lineHeight: 1.2,
    letterSpacing: 0,
  },
  caption: {
    fontFamily: fontFamily.display,
    fontSize: 14,
    fontWeight: 400,
    lineHeight: 1.0,
    letterSpacing: 1.4,
  },
  smallLabel: {
    fontFamily: fontFamily.display,
    fontSize: 12,
    fontWeight: 400,
    lineHeight: 1.35,
    letterSpacing: 2.4,
  },
  micro: {
    fontFamily: fontFamily.display,
    fontSize: 11,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: 0,
  },
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
  uiSupplement: {
    fontFamily: fontFamily.uiSupplement,
    fontSize: 16,
    fontWeight: 500,
    lineHeight: 1.0,
    letterSpacing: -0.2,
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
