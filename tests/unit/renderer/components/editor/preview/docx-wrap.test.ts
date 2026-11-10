import { describe, expect, it } from "bun:test";
import { hangulWrapOf } from "../../../../../../src/renderer/components/editor/preview/docx-wrap";

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

describe("hangulWrapOf", () => {
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
