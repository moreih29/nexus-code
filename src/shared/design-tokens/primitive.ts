export const color = {
  warmParchment: "oklch(0.982 0.0041 91.45)",
  earthGray: "oklch(0.3286 0.0017 106.49)",
  stoneGray: "oklch(0.6173 0.0019 67.79)",
  ashGray: "oklch(0.751 0.0031 84.56)",
  mutedPurple: "oklch(0.5067 0.0082 304.11)",
  darkCharcoal: "oklch(0.3904 0 0)",
  bgCanvas: "#1a1917",
  ashGrayHex: "#afaeac",
  warmParchmentHex: "#faf9f6",
  borderDefault: "rgba(226, 226, 226, 0.15)",
  mutedSurfaceHex: "#252422",
  frostedVeil: "rgba(255, 255, 255, 0.04)",
  frostedVeilStrong: "rgba(255, 255, 255, 0.1)",
  mistBorder: "rgba(226, 226, 226, 0.35)",
  mistBorderFocus: "rgba(226, 226, 226, 0.6)",
  splitter: "rgba(226, 226, 226, 0.35)",
  splitterHover: "rgba(226, 226, 226, 0.6)",
  translucentParchment: "rgba(250, 249, 246, 0.9)",
  ambientShadow: "rgba(0, 0, 0, 0.2)",
} as const;

export { fontFamily } from "./fonts";

export const spacing = [1, 4, 5, 8, 10, 12, 14, 15, 16, 18, 24, 26, 30, 32, 36] as const;

export const spacingInApp = [2, 4, 6, 8, 12, 16, 24, 32, 48] as const;

export const radiusScale = {
  none: 0,
  control: 4,
  raised: 6,
  island: 10,
  full: 9999,
} as const;

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

export const breakpoint = {
  mobile: 810,
  tablet: 1500,
} as const;
