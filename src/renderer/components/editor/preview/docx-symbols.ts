// Word's symbol fonts, Symbol and Wingdings, keep their glyphs at codes of
// their own, and a file names them by those codes: Word's bullet is U+F0B7
// set in Symbol. Only Windows' Symbol draws it there; macOS's Symbol is laid
// out by Unicode and Linux has neither font, so the bullet shows as a box.
// The characters are changed here to the Unicode ones they draw, in the
// text's own font.

type SymbolFont = "symbol" | "wingdings";

/** Symbol's characters as Unicode, a run of codes from each start. */
const SYMBOL_ROWS: [number, string][] = [
  [0x20, " !∀#∃%&∋()∗+,−./0123456789:;<=>?"],
  [0x40, "≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_"],
  [0x60, "‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼"],
  [0xa0, "€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵"],
  [0xc0, "ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓"],
  [0xe0, "◊⟨®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪"],
  [0xf1, "⟩∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭"],
];

/**
 * The Wingdings characters a list or a note is likely to use: bullets,
 * arrows and check marks, each set beside the font's own glyph to match.
 */
const WINGDINGS_CODES: [number, string][] = [
  [0x20, " "],
  [0x46, "☞"],
  [0x6c, "●"],
  [0x6d, "❍"],
  [0x6e, "■"],
  [0x6f, "□"],
  [0x71, "❑"],
  [0x72, "❒"],
  [0x73, "⬧"],
  [0x74, "⧫"],
  [0x75, "◆"],
  [0x76, "❖"],
  [0x77, "⬥"],
  [0x9e, "·"],
  [0x9f, "•"],
  [0xa0, "▪"],
  [0xa1, "○"],
  [0xa4, "◉"],
  [0xa5, "◎"],
  [0xa7, "▪"],
  [0xa8, "◻"],
  [0xaa, "✦"],
  [0xab, "★"],
  [0xd8, "➢"],
  [0xdf, "←"],
  [0xe0, "→"],
  [0xe1, "↑"],
  [0xe2, "↓"],
  [0xe7, "⬅"],
  [0xe8, "➔"],
  [0xe9, "⬆"],
  [0xea, "⬇"],
  [0xef, "⇦"],
  [0xf0, "⇨"],
  [0xfb, "✗"],
  [0xfc, "✓"],
  [0xfd, "☒"],
  [0xfe, "☑"],
];

const TABLES: Record<SymbolFont, Map<number, string>> = {
  symbol: new Map(
    SYMBOL_ROWS.flatMap(([start, chars]) =>
      Array.from(chars, (ch, i): [number, string] => [start + i, ch]),
    ),
  ),
  wingdings: new Map(WINGDINGS_CODES),
};

/** The symbol font a CSS font-family names first, if it is one. */
export function symbolFontOf(family: string): SymbolFont | null {
  const first = (family.split(",")[0] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  return first === "symbol" || first === "wingdings" ? first : null;
}

/**
 * The text set in a symbol font, as Unicode; null when the font draws a
 * character with none here, so the text keeps the font. Word writes the
 * font's code n as U+F000 + n or as n itself; anything else, as Hangul in
 * a run set in Symbol, is in another font already and is kept.
 */
export function symbolsToUnicode(font: SymbolFont, text: string): string | null {
  const table = TABLES[font];
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const own =
      code >= 0xf020 && code <= 0xf0ff ? code - 0xf000 : code >= 0x20 && code <= 0xff ? code : -1;
    if (own < 0) {
      out += ch;
      continue;
    }
    const unicode = table.get(own);
    if (unicode === undefined) return null;
    out += unicode;
  }
  return out;
}

/** A CSS escape, which stands for a character of its own. */
const CSS_ESCAPE = /(\\[0-9a-fA-F]{1,6}\s?|\\[\s\S])/;

/**
 * The stylesheet with its list markers in Unicode: docx-preview draws a
 * level's bullet as the content of a rule set in the level's font, which
 * the rule then no longer needs.
 */
export function symbolCssToUnicode(css: string): string {
  return css.replace(/\{([^{}]*)\}/g, (block, body: string) => {
    const family = /(?:^|;)\s*font-family\s*:\s*([^;]*)/.exec(body);
    const font = family ? symbolFontOf(family[1] ?? "") : null;
    if (!font) return block;
    const content = /(content\s*:\s*)"((?:[^"\\]|\\[\s\S])*)"/.exec(body);
    if (!content) return block;
    const parts = (content[2] ?? "")
      .split(CSS_ESCAPE)
      .map((part, i) => (i % 2 === 1 ? part : symbolsToUnicode(font, part)));
    if (parts.some((part) => part === null)) return block;
    const next = body
      .replace(content[0], () => `${content[1]}"${parts.join("")}"`)
      .replace(/(^|;)\s*font-family\s*:[^;]*;?/, "$1");
    return `{${next}}`;
  });
}

/**
 * Changes a drawn document's symbol-font characters to Unicode: the list
 * markers in its stylesheets, and the runs and inserted symbols in its body
 * that are set in Symbol or Wingdings.
 */
export function unicodeSymbols(styles: ParentNode, body: ParentNode): void {
  for (const style of styles.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    const next = symbolCssToUnicode(css);
    if (next !== css) style.textContent = next;
  }
  for (const element of body.querySelectorAll<HTMLElement>("[style*='font-family']")) {
    const font = symbolFontOf(element.style.fontFamily);
    // A run's text sits right in it; anything more is left in its font.
    if (!font || element.children.length > 0) continue;
    const text = symbolsToUnicode(font, element.textContent ?? "");
    if (text === null) continue;
    element.textContent = text;
    element.style.removeProperty("font-family");
  }
}
