import { describe, expect, test } from "bun:test";
import {
  cleanLinkHref,
  inlineTargetAt,
  isWindowsPathTarget,
  linkDestination,
  linkHrefOf,
  linksTo,
  linkTargetSet,
  linkTargetsIn,
  sameLinkHref,
  textLinksTo,
  withoutCode,
  writtenLinksIn,
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

  test("inline links and images, autolinks and used reference definitions count; HTML only in HTML", () => {
    const text = [
      'See [a](docs/a.md#L3) and ![chart](<out/my chart.png> "title") and [notes][ref].',
      "Also </tmp/auto.txt> and https://example.com/x.",
      "",
      "[ref]: ../notes/ref.md",
      "[unused]: ../notes/unused.md",
      "<a href=\"page.html\">x</a> <img src='pic.png'>",
    ].join("\n");
    expect(linkTargetsIn(text)).toEqual([
      "docs/a.md#L3",
      "<out/my chart.png>",
      "../notes/ref.md",
      "/tmp/auto.txt",
    ]);
    expect(textLinksTo(text, "../notes/unused.md")).toBe(false);
    expect(linkTargetsIn(text, { html: true })).toContain("page.html");
    expect(linkTargetsIn(text, { html: true })).toContain("pic.png");
    expect(textLinksTo(text, "docs/a.md")).toBe(true);
    expect(textLinksTo(text, "out/my%20chart.png")).toBe(true);
    expect(textLinksTo(text, "../notes/ref.md#L1")).toBe(true);
    expect(textLinksTo(text, "page.html")).toBe(false);
    expect(textLinksTo(text, "docs")).toBe(false);
    expect(textLinksTo(text, "")).toBe(false);
  });

  test("a Windows path target keeps its backslashes; other targets follow CommonMark", () => {
    const rows: [string, boolean, string][] = [
      [String.raw`C:\a\.b.txt`, true, String.raw`C:\a\.b.txt`],
      [String.raw`<C:\a b\.c.txt>`, true, String.raw`C:\a b\.c.txt`],
      [String.raw`C:/a\_b.txt`, true, String.raw`C:/a\_b.txt`],
      [String.raw`\\srv\sh\.x`, true, String.raw`\\srv\sh\.x`],
      [String.raw`/\srv\sh`, true, String.raw`/\srv\sh`],
      [String.raw`C:\a&amp;b.txt`, true, String.raw`C:\a&b.txt`],
      [String.raw`C&#58;\x\.y`, false, String.raw`C:\x.y`],
      [String.raw`&#92;&#92;srv\sh\.x`, false, String.raw`\\srv\sh.x`],
      [String.raw`/tmp/\_x.md`, false, "/tmp/_x.md"],
      [String.raw`javascript:alert(1)\\C:\a`, false, String.raw`javascript:alert(1)\C:\a`],
    ];
    for (const [written, windows, destination] of rows) {
      expect(isWindowsPathTarget(written)).toBe(windows);
      expect(linkDestination(written)).toBe(destination);
    }
  });

  test("an inline target is scanned the way CommonMark reads it", () => {
    const rows: [string, string | null][] = [
      [String.raw`C:\x\.y.png)`, String.raw`C:\x\.y.png`],
      [String.raw`C:\x\.y.png "t")`, String.raw`C:\x\.y.png`],
      [String.raw`C:\x\.y.png (t))`, String.raw`C:\x\.y.png`],
      [`${String.raw`C:\x\.y.png`}\n"multi\nline")`, String.raw`C:\x\.y.png`],
      [String.raw`  C:\x\.y.png  )`, String.raw`C:\x\.y.png`],
      [String.raw`C:\x(1)\.y.png)`, String.raw`C:\x(1)\.y.png`],
      [String.raw`C:\x\)y.png)`, String.raw`C:\x\)y.png`],
      [String.raw`<C:\a b\.c.txt> 't')`, String.raw`<C:\a b\.c.txt>`],
      [String.raw`C:\x(1 "t")`, null],
      [String.raw`C:\x "t" junk)`, null],
      [String.raw`C:\x "a${"\n\n"}b")`, null],
      [")", null],
    ];
    for (const [text, written] of rows)
      expect(inlineTargetAt(text, 0)?.written ?? null).toBe(written);
  });

  test("code spans and fenced blocks hold no links", () => {
    const text = [
      "Real [a](a.md) and `[b](b.md)` and ``[c](c.md) ` x``.",
      "```",
      "[d](d.md)",
      "```",
      "~~~",
      "[e](e.md)",
      "~~~",
      "![f](f.png) after.",
      "```",
      "[g](g.md)",
    ].join("\n");
    expect(writtenLinksIn(text)).toEqual([
      { written: "a.md", image: false, at: text.indexOf("](a.md") },
      { written: "f.png", image: true, at: text.indexOf("](f.png") },
    ]);
    expect(withoutCode("a `b` c")).toBe("a     c");
    expect(withoutCode("a `b c")).toBe("a `b c");
  });

  test("a path in backticks counts only when the caller says so", () => {
    const text = "Wrote `/tmp/out.txt` and `npm test`.";
    expect(textLinksTo(text, "/tmp/out.txt")).toBe(false);
    expect(textLinksTo(text, "/tmp/out.txt", { code: (w) => w === "/tmp/out.txt" })).toBe(true);
  });
});

function elapsed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

const BOUND_MS = 2000;
const LONG_TEST_MS = 120_000;

describe("reading a long text takes time in line with its length", () => {
  test.each([
    ["label-less ](x) repeated", "](x)".repeat(40_000), 0],
    ["table rows with a](b) in a cell", "| a](b) | c |\n".repeat(15_000), 0],
    ["one paragraph of x](y)", "x](y) ".repeat(30_000), 0],
    [
      "40000 definitions and 40000 links",
      `${Array.from({ length: 40_000 }, (_, i) => `[d${i}]: /x${i}`).join("\n")}\n\n${"[a](/b) ".repeat(40_000)}`,
      40_000,
    ],
    [
      "3 MB of backtick runs that all differ in length",
      (() => {
        let runs = "";
        for (let size = 1; runs.length < 3_000_000; size++) runs += `${"`".repeat(size)}a`;
        return runs;
      })(),
      0,
    ],
    ["CRLF paragraphs of ](x)", "a](x)\r\n\r\n".repeat(40_000), 0],
    ["unclosed inline comments", "x <!-- [a](/b) ".repeat(40_000), 40_000],
  ])(
    "%s",
    (_name, text, count) => {
      let links = 0;
      expect(elapsed(() => (links = writtenLinksIn(text).length))).toBeLessThan(BOUND_MS);
      expect(links).toBe(count);
      expect(elapsed(() => textLinksTo(text, "nope.md"))).toBeLessThan(BOUND_MS);
    },
    LONG_TEST_MS,
  );

  test(
    "one 1 MB text answers 64 links after reading it once",
    () => {
      let text = "";
      for (let i = 0; text.length < 1_000_000; i++) {
        text += `- see [file ${i}](docs/f${i}.md) and \`code ${i}\`\n`;
      }
      let found = 0;
      const took = elapsed(() => {
        const targets = linkTargetSet(text);
        for (let i = 0; i < 64; i++) if (linksTo(targets, `docs/f${i * 2}.md`)) found++;
      });
      expect(took).toBeLessThan(BOUND_MS);
      expect(found).toBe(64);
    },
    LONG_TEST_MS,
  );
});
