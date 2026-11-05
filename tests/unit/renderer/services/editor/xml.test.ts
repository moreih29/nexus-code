import { describe, expect, it } from "bun:test";
import { decodeEntities, scanXml } from "../../../../../src/renderer/services/editor/preview/xml";

/** What the scanner reports, in order, as short strings. */
function scan(xml: string): string[] {
  const events: string[] = [];
  scanXml(xml, {
    start: (name, attrs, empty) =>
      events.push(`<${name}${JSON.stringify(attrs)}${empty ? "/" : ""}>`),
    end: (name) => events.push(`</${name}>`),
    text: (text) => events.push(text),
  });
  return events;
}

describe("scanXml", () => {
  it("reports starts, ends and text, names without their prefix", () => {
    expect(scan('<?xml version="1.0"?><x:a k="1" r:id=\'r2\'><b/>hi</x:a>')).toEqual([
      '<a{"k":"1","r:id":"r2"}>',
      "<b{}/>",
      "</b>",
      "hi",
      "</a>",
    ]);
  });

  it("decodes entities in text and attributes, and keeps CDATA as it is", () => {
    expect(
      scan('<t v="a &amp; &quot;b&quot;">x &lt; y &#65;&#x42;<![CDATA[<raw> &amp;]]></t>'),
    ).toEqual(['<t{"v":"a & \\"b\\""}>', "x < y AB", "<raw> &amp;", "</t>"]);
  });

  it("skips comments and does not end a tag at a > inside quotes", () => {
    expect(scan('<a><!-- <b> --><c f="x>y"/></a>')).toEqual([
      "<a{}>",
      '<c{"f":"x>y"}/>',
      "</c>",
      "</a>",
    ]);
  });

  it("stops at the end of unfinished XML", () => {
    expect(scan("<a>text<b")).toEqual(["<a{}>", "text", "<b{}>"]);
  });
});

describe("decodeEntities", () => {
  it("leaves unknown and out of range references as they are", () => {
    expect(decodeEntities("&nbsp; &#0; &#x110000; &amp")).toBe("&nbsp; &#0; &#x110000; &amp");
  });
});
