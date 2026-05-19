// src/renderer/hooks/use-effective-editor-font.ts — Effective editor font values.
//
// Synthesizes user overrides from useEditorFontStore with token fallbacks.
// Result is stable-reference-friendly (plain object recalculated only when
// store values change); callers may pass the result directly to Monaco's
// updateOptions({}) or a CSS style prop.
//
// Design seal: codeBody is the authoritative token fallback; user override wins.
// fontFamily CSS chain: "<user>, 'JetBrains Mono Nerd Font', 'Sarasa Term K', ui-monospace, monospace"

import { typeScale } from "../../shared/design-tokens";
import { fontFamily } from "../../shared/design-tokens/primitive";
import { useEditorFontStore } from "../state/stores/editor-font";

// ---------------------------------------------------------------------------
// Token fallbacks (codeBody is the authoritative source per design seal)
// ---------------------------------------------------------------------------

// codeBody.fontSize = 16 (design-tokens/index.ts)
const TOKEN_FONT_SIZE = typeScale.codeBody.fontSize;
// codeBody.lineHeight = 1.0 in token, but design seal sets editor fallback to 1.4.
const TOKEN_LINE_HEIGHT: number = 1.4;
// fontFamily.monoDisplay is the base chain for the editor.
const TOKEN_FONT_FAMILY_TAIL = fontFamily.monoDisplay;
// Ligatures off by default (no ligature token in codeBody).
const TOKEN_LIGATURES = false;

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface EffectiveEditorFont {
  /** Font size in px (e.g. 16). */
  fontSize: number;
  /**
   * Full CSS font-family string.
   * If the user has set a family the chain is:
   *   "<user>", 'JetBrains Mono Nerd Font', 'Sarasa Term K', ui-monospace, monospace
   * Otherwise the monoDisplay token chain is used unchanged.
   */
  fontFamily: string;
  /**
   * Whether to enable font ligatures.
   * Maps to Monaco's `fontLigatures` option.
   */
  fontLigatures: boolean;
  /** Line height multiplier (e.g. 1.4). */
  lineHeight: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useEffectiveEditorFont(): EffectiveEditorFont {
  const size = useEditorFontStore((s) => s.size);
  const family = useEditorFontStore((s) => s.family);
  const ligatures = useEditorFontStore((s) => s.ligatures);
  const lineHeight = useEditorFontStore((s) => s.lineHeight);

  return buildEffectiveEditorFont({ size, family, ligatures, lineHeight });
}

// ---------------------------------------------------------------------------
// Pure helper — also used by Monaco wiring (no React dependency)
// ---------------------------------------------------------------------------

export function buildEffectiveEditorFont(opts: {
  size: number | undefined;
  family: string | undefined;
  ligatures: boolean | undefined;
  lineHeight: number | undefined;
}): EffectiveEditorFont {
  const fontSize = opts.size ?? TOKEN_FONT_SIZE;

  const resolvedFamily =
    opts.family !== undefined && opts.family.trim() !== ""
      ? `"${opts.family}", ${TOKEN_FONT_FAMILY_TAIL}`
      : TOKEN_FONT_FAMILY_TAIL;

  const fontLigatures = opts.ligatures ?? TOKEN_LIGATURES;
  const resolvedLineHeight = opts.lineHeight ?? TOKEN_LINE_HEIGHT;

  return {
    fontSize,
    fontFamily: resolvedFamily,
    fontLigatures,
    lineHeight: resolvedLineHeight,
  };
}
