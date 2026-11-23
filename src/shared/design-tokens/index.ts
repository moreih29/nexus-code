export { buildShadcnVars, SEALED } from "./component";
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
export type { SemanticKey, SemanticTokenSet } from "./semantic";
export type { EditorPalette } from "./theme-adapter";
export { buildEditorPalette, buildSemanticTokens } from "./theme-adapter";
export type { ThemeSource } from "./theme-sources";
export type { ThemeId } from "./themes";
export { DEFAULT_THEME, THEME_SOURCE_BY_ID, THEME_SOURCES, THEMES } from "./themes";

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
  appMicro: {
    fontFamily: fontFamily.display,
    fontSize: 11,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: 0,
  },
  appLabel: {
    fontFamily: fontFamily.display,
    fontSize: 12,
    fontWeight: 400,
    lineHeight: 1.35,
    letterSpacing: 0,
  },
} as const;
