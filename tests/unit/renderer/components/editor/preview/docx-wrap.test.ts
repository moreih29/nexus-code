import { describe, expect, it } from "bun:test";
import {
  hangulWrapOf,
  ideographicRuns,
  styleClassOf,
} from "../../../../../../src/renderer/components/editor/preview/docx-wrap";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function stylesXml(defaults: string, styles: string): string {
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<w:styles ${W}>`,
    `<w:docDefaults><w:rPrDefault><w:rPr/></w:rPrDefault>`,
    `<w:pPrDefault>${defaults}</w:pPrDefault></w:docDefaults>`,
    styles,
    `</w:styles>`,
  ].join("");
}

/** As Korean Word's Normal template writes its paragraph defaults. */
const KOREAN_DEFAULTS =
  '<w:pPr><w:widowControl w:val="0"/><w:wordWrap w:val="0"/><w:autoSpaceDE w:val="0"/><w:jc w:val="both"/></w:pPr>';

const NORMAL =
  '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:qFormat/></w:style>';

describe("styleClassOf", () => {
  it("names a style's class as docx-preview does", () => {
    expect(styleClassOf("docx", "Heading1")).toBe("docx_heading1");
    expect(styleClassOf("docx", "Weird Id.x&y")).toBe("docx_weird-id-xandy");
    expect(styleClassOf("docx", "한글스타일")).toBe("docx_한글스타일");
  });
});

describe("hangulWrapOf", () => {
  it("keeps Hangul words whole in every paragraph of Korean Word's template", () => {
    const wrap = hangulWrapOf(
      stylesXml(
        KOREAN_DEFAULTS,
        `${NORMAL}<w:style w:type="paragraph" w:styleId="1"><w:basedOn w:val="a"/><w:pPr><w:keepNext/></w:pPr></w:style>`,
      ),
      "docx",
    );
    expect(wrap.plain).toBe(false);
    expect([...wrap.byClass]).toEqual([
      ["docx_a", false],
      ["docx_1", false],
    ]);
  });

  it("lets a style break words again, and the styles based on it", () => {
    const wrap = hangulWrapOf(
      stylesXml(
        KOREAN_DEFAULTS,
        [
          NORMAL,
          '<w:style w:type="paragraph" w:styleId="Break"><w:basedOn w:val="a"/><w:pPr><w:wordWrap/></w:pPr></w:style>',
          '<w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Break"/></w:style>',
          '<w:style w:type="paragraph" w:styleId="Keep"><w:basedOn w:val="Break"/><w:pPr><w:wordWrap w:val="false"/></w:pPr></w:style>',
        ].join(""),
      ),
      "docx",
    );
    expect(wrap.byClass.get("docx_break")).toBe(true);
    expect(wrap.byClass.get("docx_child")).toBe(true);
    expect(wrap.byClass.get("docx_keep")).toBe(false);
  });

  it("breaks Hangul anywhere in a document that sets no wordWrap, as Word does", () => {
    const wrap = hangulWrapOf(stylesXml('<w:pPr><w:jc w:val="both"/></w:pPr>', NORMAL), "docx");
    expect(wrap.plain).toBe(true);
    expect(wrap.byClass.get("docx_a")).toBe(true);
  });

  it("takes a paragraph of no style as the default paragraph style", () => {
    const wrap = hangulWrapOf(
      stylesXml(
        "",
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:pPr><w:wordWrap w:val="0"/></w:pPr></w:style>',
      ),
      "docx",
    );
    expect(wrap.plain).toBe(false);
  });

  it("reads only paragraph styles, and a style's ids as XML writes them", () => {
    const wrap = hangulWrapOf(
      stylesXml(
        KOREAN_DEFAULTS,
        [
          '<w:style w:type="character" w:styleId="Char"><w:rPr/></w:style>',
          '<w:style w:type="paragraph" w:styleId="A&amp;B"><w:pPr><w:wordWrap w:val="1"/></w:pPr></w:style>',
          '<w:style w:type="table" w:styleId="Grid"/>',
        ].join(""),
      ),
      "docx",
    );
    expect([...wrap.byClass]).toEqual([["docx_aandb", true]]);
  });

  it("ignores what a tracked change replaced, and a loop of styles", () => {
    const wrap = hangulWrapOf(
      stylesXml(
        KOREAN_DEFAULTS,
        [
          '<w:style w:type="paragraph" w:styleId="Changed"><w:pPr><w:pPrChange w:id="1"><w:pPr><w:wordWrap w:val="1"/></w:pPr></w:pPrChange></w:pPr></w:style>',
          '<w:style w:type="paragraph" w:styleId="X"><w:basedOn w:val="Y"/></w:style>',
          '<w:style w:type="paragraph" w:styleId="Y"><w:basedOn w:val="X"/></w:style>',
        ].join(""),
      ),
      "docx",
    );
    expect(wrap.byClass.get("docx_changed")).toBe(false);
    expect(wrap.byClass.get("docx_x")).toBe(false);
  });
});

describe("ideographicRuns", () => {
  it("finds the Chinese and Japanese in Korean, with the punctuation among it", () => {
    const text = "한국어 문단: 中文段落，汉字之间。 그리고 ひらがなとカタカナー 끝";
    expect(ideographicRuns(text).map(([start, end]) => text.slice(start, end))).toEqual([
      "中文段落，汉字之间。",
      "ひらがなとカタカナー",
    ]);
  });

  it("finds none in Hangul, or in punctuation alone", () => {
    expect(ideographicRuns("「한글」 문장입니다。")).toEqual([]);
  });
});
