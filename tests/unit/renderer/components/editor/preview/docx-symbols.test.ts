import { describe, expect, it } from "bun:test";
import {
  symbolCssToUnicode,
  symbolFontOf,
  symbolsToUnicode,
} from "../../../../../../src/renderer/components/editor/preview/docx-symbols";

describe("symbolFontOf", () => {
  it("knows Symbol and Wingdings when named first, quoted or not", () => {
    expect(symbolFontOf("Symbol")).toBe("symbol");
    expect(symbolFontOf("'Wingdings', serif")).toBe("wingdings");
    expect(symbolFontOf('"symbol"')).toBe("symbol");
    expect(symbolFontOf("Calibri, Symbol")).toBeNull();
    expect(symbolFontOf("Wingdings 2")).toBeNull();
    expect(symbolFontOf("")).toBeNull();
  });
});

describe("symbolsToUnicode", () => {
  it("draws Word's bullet, at the font's code or its own", () => {
    expect(symbolsToUnicode("symbol", "\uF0B7")).toBe("•");
    expect(symbolsToUnicode("symbol", "·")).toBe("•");
  });

  it("reads Symbol's letters as Greek and its marks as math", () => {
    expect(symbolsToUnicode("symbol", "abg D")).toBe("αβγ Δ");
    expect(symbolsToUnicode("symbol", "\uF0B3\uF0B9\uF0AE")).toBe("≥≠→");
  });

  it("keeps characters of other fonts, as Hangul in a run set in Symbol", () => {
    expect(symbolsToUnicode("symbol", "가\t\uF0B7")).toBe("가\t•");
  });

  it("draws the Wingdings bullets, arrows and checks", () => {
    expect(symbolsToUnicode("wingdings", "\uF0A7\uF0D8\uF0FC\uF076\uF0E0")).toBe("▪➢✓❖→");
  });

  it("leaves text in its font when a character has no Unicode here", () => {
    expect(symbolsToUnicode("wingdings", "\uF0A7\uF061")).toBeNull();
    expect(symbolsToUnicode("symbol", "\uF0F0")).toBeNull();
  });
});

describe("symbolCssToUnicode", () => {
  it("writes a list level's bullet in Unicode, out of the symbol font", () => {
    const css =
      'p.docx-num-1-0:before { content: "\uF0B7\\9"; counter-increment: docx-num-1-0; font-family: Symbol; }\n' +
      'p.docx-num-1-2:before { content: "\uF0A7\\9"; font-family: Wingdings; counter-increment: docx-num-1-2; }';
    expect(symbolCssToUnicode(css)).toBe(
      'p.docx-num-1-0:before { content: "•\\9"; counter-increment: docx-num-1-0; }\n' +
        'p.docx-num-1-2:before { content: "▪\\9"; counter-increment: docx-num-1-2; }',
    );
  });

  it("leaves rules in other fonts, without content, or with an unknown character", () => {
    const css = [
      "p.a:before { content: \"o\\9\"; font-family: 'Courier New'; }",
      ".docx span.b { font-family: Symbol; }",
      'p.c:before { content: "\uF061\\9"; font-family: Wingdings; }',
    ].join("\n");
    expect(symbolCssToUnicode(css)).toBe(css);
  });

  it("keeps CSS escapes, which are not the font's characters", () => {
    // \5C is a backslash, which Symbol would draw as ∴.
    const css = 'p.d:before { content: "\\5C \uF0B7"; font-family: Symbol; }';
    expect(symbolCssToUnicode(css)).toBe('p.d:before { content: "\\5C •"; }');
  });
});
