import { describe, expect, test } from "bun:test";
import {
  cleanLinkHref,
  linkHrefOf,
  linkTargetsIn,
  sameLinkHref,
  textLinksTo,
} from "../../../src/shared/chat/link-text";

describe("a link as another device sends it and as a chat wrote it", () => {
  test("are both cleaned the same way before they are compared", () => {
    expect(cleanLinkHref(String.raw`/tmp/a\_b.md`)).toBe("/tmp/a_b.md");
    expect(cleanLinkHref("</tmp/my file.md>")).toBe("/tmp/my file.md");
    expect(cleanLinkHref("/tmp/a&amp;b&#x20;c&#33;.md")).toBe("/tmp/a&b c!.md");
    expect(cleanLinkHref("/tmp/my%20file.md")).toBe("/tmp/my file.md");
    expect(cleanLinkHref(String.raw`C:\Users\me\a.md`)).toBe("C:/Users/me/a.md");
    expect(cleanLinkHref("/tmp/bad%zz.md")).toBe("/tmp/bad%zz.md");
  });

  test("line tails come off: #L12, #L12-L20, :12 and :12:3", () => {
    for (const written of ["a.md#L12", "a.md#L12-L20", "a.md#l3-4", "a.md:12", "a.md:12:3"]) {
      expect(cleanLinkHref(written)).toBe("a.md");
      expect(linkHrefOf(written)).toBe("a.md");
      expect(sameLinkHref(written, "a.md")).toBe(true);
    }
    expect(linkHrefOf("<docs/a b.md#L4>")).toBe("docs/a b.md");
    expect(cleanLinkHref("Makefile:12")).toBe("Makefile:12");
    expect(cleanLinkHref("a.md#usage")).toBe("a.md#usage");
  });

  test("inline links and images, autolinks and reference definitions count; HTML only in HTML", () => {
    const text = [
      'See [a](docs/a.md#L3) and ![chart](<out/my chart.png> "title").',
      "Also </tmp/auto.txt> and https://example.com/x.",
      "[ref]: ../notes/ref.md",
      "<a href=\"page.html\">x</a> <img src='pic.png'>",
    ].join("\n");
    expect(linkTargetsIn(text)).toEqual([
      "docs/a.md#L3",
      "<out/my chart.png>",
      "/tmp/auto.txt",
      "../notes/ref.md",
    ]);
    expect(linkTargetsIn(text, { html: true })).toContain("page.html");
    expect(linkTargetsIn(text, { html: true })).toContain("pic.png");
    expect(textLinksTo(text, "docs/a.md")).toBe(true);
    expect(textLinksTo(text, "out/my%20chart.png")).toBe(true);
    expect(textLinksTo(text, "../notes/ref.md#L1")).toBe(true);
    expect(textLinksTo(text, "page.html")).toBe(false);
    expect(textLinksTo(text, "docs")).toBe(false);
    expect(textLinksTo(text, "")).toBe(false);
  });

  test("a path in backticks counts only when the caller says so", () => {
    const text = "Wrote `/tmp/out.txt` and `npm test`.";
    expect(textLinksTo(text, "/tmp/out.txt")).toBe(false);
    expect(textLinksTo(text, "/tmp/out.txt", { code: (w) => w === "/tmp/out.txt" })).toBe(true);
  });
});
