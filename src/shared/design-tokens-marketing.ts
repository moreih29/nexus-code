// Marketing/landing surface type scale (Warp scale, 18 roles).
//
// Synced with .nexus/context/design.md. NOT used by the application chrome
// directly — the codeUi / codeBody entries below are the only roles the
// app currently consumes (Monaco / xterm). Every role is still emitted
// to Tailwind via `scripts/generate-theme-css.ts` so marketing surfaces
// (landing pages, docs) can use `text-display-hero` etc.
//
// Kept in its own module so design-tokens.ts stays focused on the in-app
// chrome tokens (color palette, semantic CSS vars, spacing, radius, app
// type scale). Updates to design.md only touch this file.

import { fontFamily } from "./design-tokens-fonts";

export const marketingTypeScale = {
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
  uiSupplement: {
    fontFamily: fontFamily.uiSupplement,
    fontSize: 16,
    fontWeight: 500,
    lineHeight: 1.0,
    letterSpacing: -0.2,
  },
} as const;
