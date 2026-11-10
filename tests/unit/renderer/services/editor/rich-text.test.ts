import { describe, expect, it } from "bun:test";
import {
  parseStyle,
  sanitizeRichText,
} from "../../../../../src/renderer/services/editor/preview/rich-text";

describe("sanitizeRichText", () => {
  it("drops what could run or load, keeping the text of what it drops", () => {
    expect(
      sanitizeRichText(
        '<p onclick="x()"><img src=x onerror="alert(1)"><a href="javascript:alert(1)">link</a><script>alert(2)</script><iframe src="https://e.x">in</iframe></p>',
      ),
    ).toEqual([{ tag: "p", style: {}, children: ["link", "in"] }]);
  });

  it("reads a < that starts no tag as text", () => {
    expect(sanitizeRichText("<p>a < b &amp; 1<2</p>")).toEqual([
      { tag: "p", style: {}, children: ["a < b & 1<2"] },
    ]);
  });

  it("closes what is left open, and ignores a stray end", () => {
    expect(sanitizeRichText("<p><b>bold</p>after</i>")).toEqual([
      { tag: "p", style: {}, children: [{ tag: "b", style: {}, children: ["bold"] }] },
      "after",
    ]);
  });
});

describe("parseStyle", () => {
  it("keeps only allowed properties with safe values", () => {
    expect(
      parseStyle(
        'color: red; position: fixed; background-color: url(x); font-family: "A;B", serif; background-image: url(https://e.x/t.png); font-size: 12pt !important',
      ),
    ).toEqual({ color: "red", "font-family": '"A;B", serif', "font-size": "12pt" });
    expect(parseStyle("color: expression(alert(1)); text-shadow: 1px 1px <b>")).toEqual({});
  });
});
