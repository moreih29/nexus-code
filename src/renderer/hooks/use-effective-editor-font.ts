import { typeScale } from "../../shared/design-tokens";
import { fontFamily } from "../../shared/design-tokens/primitive";
import { useEditorFontStore } from "../state/stores/editor-font";

const TOKEN_FONT_SIZE = typeScale.codeBody.fontSize;
const TOKEN_LINE_HEIGHT: number = 1.4;
const TOKEN_FONT_FAMILY_TAIL = fontFamily.monoDisplay;
const TOKEN_LIGATURES = false;

export interface EffectiveEditorFont {
  fontSize: number;
  fontFamily: string;
  fontLigatures: boolean;
  lineHeight: number;
}

export function useEffectiveEditorFont(): EffectiveEditorFont {
  const size = useEditorFontStore((s) => s.size);
  const family = useEditorFontStore((s) => s.family);
  const ligatures = useEditorFontStore((s) => s.ligatures);
  const lineHeight = useEditorFontStore((s) => s.lineHeight);

  return buildEffectiveEditorFont({ size, family, ligatures, lineHeight });
}

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
