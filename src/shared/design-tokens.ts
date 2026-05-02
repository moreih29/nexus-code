// TODO: Keep this file in sync with .nexus/context/design.md.
// When design.md is updated, review and update the token values below accordingly.

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------

export const color = {
  // Primary
  warmParchment: "#faf9f6",
  earthGray: "#353534",
  // Secondary / accent
  stoneGray: "#868584",
  ashGray: "#afaeac",
  mutedPurple: "#666469",
  darkCharcoal: "#454545",
  // Surfaces
  frostedVeil: "rgba(255, 255, 255, 0.04)",
  mistBorder: "rgba(226, 226, 226, 0.35)",
  translucentParchment: "rgba(250, 249, 246, 0.9)",
  // Depth / elevation
  ambientShadow: "rgba(0, 0, 0, 0.2)",
} as const;

// ---------------------------------------------------------------------------
// Typography — font families
// ---------------------------------------------------------------------------

export const fontFamily = {
  display: "'Matter Regular', 'Matter Regular Placeholder', sans-serif",
  medium: "'Matter Medium', 'Matter Medium Placeholder', sans-serif",
  square: "'Matter SQ Regular', 'Matter SQ Regular Placeholder', sans-serif",
  uiSupplement: "'Inter', 'Inter Placeholder', sans-serif",
  monoDisplay: "'Geist Mono', monospace",
  monoBody: "'Matter Mono Regular', 'Matter Mono Regular Placeholder', monospace",
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
