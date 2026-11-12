// index.ts — barrel re-export only.
//
// All public exports are preserved so existing consumer import paths are unchanged.
//
// File layout (design.md §0 / §8 Token Tiering):
//   primitive.ts   → raw immutable scales (color, spacing, radius, fontFamily)
//   semantic.ts    → SemanticKey union + SemanticTokenSet type
//   component.ts   → buildShadcnVars() adapter + SEALED constants
//   themes/        → per-theme SemanticTokenSet implementations
//   index.ts       → this barrel (no logic, no values)
//
// NOTE: ./marketing.ts exists and is NOT re-exported here.
//   The marketing 18-role type scale is removed from the in-app token surface
//   per design.md §5 ("the marketing 18-role type scale cannot be used in in-app UI").
//   Existing CSS output for marketing text roles is preserved in
//   generate-theme-css.ts via direct import during the transition period.

// ---------------------------------------------------------------------------
// primitive — raw values (color palette, font families, spacing, radius)
// ---------------------------------------------------------------------------

export {
  borderRadius,
  breakpoint,
  color,
  fontFamily,
  islandGeometry,
  radiusScale,
  spacing,
  spacingInApp,
} from "./primitive";

// ---------------------------------------------------------------------------
// semantic — type contracts only (no values)
// ---------------------------------------------------------------------------

export type { SemanticKey, SemanticTokenSet } from "./semantic";

// ---------------------------------------------------------------------------
// component — shadcn adapter + SEALED constants
// ---------------------------------------------------------------------------

export { buildShadcnVars, SEALED } from "./component";

// ---------------------------------------------------------------------------
// themes — ThemeId type + registry (single shared source of truth)
// ---------------------------------------------------------------------------

export type { ThemeId } from "./themes";
export { DEFAULT_THEME, THEME_SOURCE_BY_ID, THEME_SOURCES, THEMES } from "./themes";

// ---------------------------------------------------------------------------
// theme-adapter — exposes buildSemanticTokens / buildEditorPalette to
// downstream consumers (palette.ts, tests, scripts).
// ---------------------------------------------------------------------------

export type { EditorPalette } from "./theme-adapter";
export { buildEditorPalette, buildSemanticTokens } from "./theme-adapter";
export type { ThemeSource } from "./theme-sources";

// ---------------------------------------------------------------------------
// Typography — in-app type scale (design.md §5)
// The `typeScale` export is kept for backward compatibility with consumers
// that import `typeScale.codeUi` / `typeScale.codeBody` (editor-view, diff-tab,
// terminal controller, cn.ts). It now contains ONLY the in-app + code roles —
// marketing roles are removed from this public surface.
// ---------------------------------------------------------------------------

import { fontFamily } from "./primitive";

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

/**
 * In-app + code type scale.
 * Marketing 18-role scale removed (design.md §5).
 * Existing consumers of typeScale.codeUi / typeScale.codeBody are unaffected.
 */
export const typeScale = {
  ...codeTypeScale,
} as const;

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
  // appMicro — smallest in-app text (11px) for tooltips, secondary path/metadata
  // hints, and inline validation captions. Sentence-case, 0 tracking.
  appMicro: {
    fontFamily: fontFamily.display,
    fontSize: 11,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: 0,
  },
  // appLabel — section and category labels. Untracked here: a label written
  // `text-app-label uppercase` is set in capitals and tracked out only in a
  // Latin-script language, by the section-label rule in globals.css. Hangul has
  // no case, and tracking only pulls its syllables apart, so in Korean the
  // label keeps its text as written and takes Medium weight instead. Callers
  // do not add their own `tracking-[…]`.
  appLabel: {
    fontFamily: fontFamily.display,
    fontSize: 12,
    fontWeight: 400,
    lineHeight: 1.35,
    letterSpacing: 0,
  },
} as const;
