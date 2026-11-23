type SymbolFont = "symbol" | "wingdings";

const SYMBOL_ROWS: [number, string][] = [
  [0x20, " !∀#∃%&∋()∗+,−./0123456789:;<=>?"],
  [0x40, "≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_"],
  [0x60, "‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼"],
  [0xa0, "€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵"],
  [0xc0, "ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓"],
  [0xe0, "◊⟨®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪"],
  [0xf1, "⟩∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭"],
];

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

export function symbolFontOf(family: string): SymbolFont | null {
  const first = (family.split(",")[0] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  return first === "symbol" || first === "wingdings" ? first : null;
}

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

const CSS_ESCAPE = /(\\[0-9a-fA-F]{1,6}\s?|\\[\s\S])/;

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

export function unicodeSymbols(styles: ParentNode, body: ParentNode): void {
  for (const style of styles.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    const next = symbolCssToUnicode(css);
    if (next !== css) style.textContent = next;
  }
  for (const element of body.querySelectorAll<HTMLElement>("[style*='font-family']")) {
    const font = symbolFontOf(element.style.fontFamily);
    if (!font || element.children.length > 0) continue;
    const text = symbolsToUnicode(font, element.textContent ?? "");
    if (text === null) continue;
    element.textContent = text;
    element.style.removeProperty("font-family");
  }
}
