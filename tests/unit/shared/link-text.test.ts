import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanLinkHref,
  inlineTargetAt,
  isWindowsPathTarget,
  LINK_TEXT_TIME_LIMIT_MS,
  linkDestination,
  linkHrefOf,
  linksTo,
  linkTargetSet,
  linkTargetsIn,
  logLinkTextStops,
  sameLinkHref,
  textLinksTo,
  type WrittenLink,
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
const QUARTER_MB = 262_144;

const stops: string[] = [];

beforeAll(() => logLinkTextStops((line) => stops.push(line)));
afterAll(() => logLinkTextStops((line) => console.warn(line)));
beforeEach(() => {
  stops.length = 0;
});

describe("reading a long text takes time in line with its length", () => {
  test.each([
    ["label-less ](x) repeated", "](x)".repeat(40_000), 0],
    ["table rows with a](b) in a cell", "| a](b) | c |\n".repeat(15_000), 0],
    ["one paragraph of x](y)", "x](y) ".repeat(30_000), 0],
    ["one paragraph of unclosed link destinations", `[a](${"x".repeat(1000)}`.repeat(1044), 0],
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
    [
      "comments after a long quote prefix",
      `${"> ".repeat(QUARTER_MB / 4)}x ${"<!--".repeat(QUARTER_MB / 8)}`,
      0,
    ],
    [
      "comments after a long list prefix",
      `${"- ".repeat(QUARTER_MB / 4)}x ${"<!--".repeat(QUARTER_MB / 8)}`,
      0,
    ],
    [
      "closed comments after a long quote prefix",
      `${"> ".repeat(QUARTER_MB / 4)}x ${"<!-- -->".repeat(QUARTER_MB / 16)}`,
      0,
    ],
    ["escaped brackets after a definition", `[r]: /r\n\n${"\\[".repeat(QUARTER_MB / 2)}`, 0],
    ["unclosed autolinks", "</".repeat(QUARTER_MB / 2), 0],
    [
      "references to one long definition",
      `[r]: C:/${"x".repeat(QUARTER_MB / 2)}\n\n${"[r] ".repeat(QUARTER_MB / 8)}`,
      QUARTER_MB / 8,
    ],
  ])(
    "%s",
    (_name, text, count) => {
      let links = 0;
      expect(elapsed(() => (links = writtenLinksIn(text).length))).toBeLessThan(BOUND_MS);
      expect(links).toBe(count);
      expect(elapsed(() => textLinksTo(text, "nope.md"))).toBeLessThan(BOUND_MS);
      expect(stops).toEqual([]);
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

const GROWTH_LIMIT = 8;
const FLOOR_MS = 25;
const LARGE_BOUND_MS = 3000;
const TOKENS = ["<!--", "-->", "](", "[", "![", "`", "` ", "```", "~~~", "[r]:", "<", "&#", "\\"];
const SHAPES: [string, (token: string, size: number) => string][] = [
  [
    "after a long quote prefix",
    (token, size) =>
      `${"> ".repeat(size / 8)}x ${token.repeat(Math.ceil(size / 2 / token.length))}`,
  ],
  [
    "after a long bullet prefix",
    (token, size) =>
      `${"- ".repeat(size / 8)}x ${token.repeat(Math.ceil(size / 2 / token.length))}`,
  ],
  [
    "after a long numbered prefix",
    (token, size) =>
      `${"1. ".repeat(Math.floor(size / 12))}x ${token.repeat(Math.ceil(size / 2 / token.length))}`,
  ],
  ["repeated on one line", (token, size) => token.repeat(Math.ceil(size / token.length))],
  ["on every line", (token, size) => `${token}\n`.repeat(Math.ceil(size / (token.length + 1)))],
];

describe("each special token takes time in line with how often it is written", () => {
  test.each(
    TOKENS.flatMap((token) =>
      SHAPES.map(([shape, make]): [string, string, (token: string, size: number) => string] => [
        `${JSON.stringify(token)} ${shape}`,
        token,
        make,
      ]),
    ),
  )(
    "%s",
    (_name, token, make) => {
      const time = (size: number) => {
        const text = `[r]: /r\n\n${make(token, size)}`;
        const run = () => linkTargetSet(text);
        run();
        return Math.min(elapsed(run), elapsed(run), elapsed(run));
      };
      const small = time(QUARTER_MB);
      const large = time(4 * QUARTER_MB);
      expect(large).toBeLessThan(LARGE_BOUND_MS);
      expect(large).toBeLessThan(GROWTH_LIMIT * Math.max(small, FLOOR_MS));
      expect(stops).toEqual([]);
    },
    LONG_TEST_MS,
  );
});

const HIDDEN = [
  "C:/fence.png",
  "C:/fenceauto.png",
  "C:/comment.png",
  "C:/span.png",
  "C:/alt.png",
  "C:/title.png",
];

const STOPPED_TEXT = Array.from({ length: 12 }, (_, i) =>
  [
    `[a${i}](C:/a${i}.png) and ![b${i}](C:/b${i}.png)`,
    "",
    "```",
    "[f](C:/fence.png) <C:/fenceauto.png>",
    "```",
    "> <!-- note",
    "> [c](C:/comment.png)",
    "> -->",
    `x \`[s](C:/span.png)\` y [r${i}]`,
    "",
    "![i [n](C:/alt.png)](C:/img.png)",
    "",
    `[r${i}]: C:/def${i}.png "[t](C:/title.png)"`,
    "",
  ].join("\n"),
).join("\n");

function fakeClock(): () => number {
  let now = 0;
  return () => now++;
}

function inOrderWithin(part: readonly WrittenLink[], whole: readonly WrittenLink[]): boolean {
  let at = 0;
  for (const link of part) {
    while (at < whole.length && JSON.stringify(whole[at]) !== JSON.stringify(link)) at++;
    if (at === whole.length) return false;
    at++;
  }
  return true;
}

describe("a reading that runs past its time limit", () => {
  test(
    "keeps only links the whole reading finds, and none from code, comments, titles or alt text",
    () => {
      const full = writtenLinksIn(STOPPED_TEXT);
      expect(full.length).toBe(12 * 4);
      expect(stops).toEqual([]);
      let partial = 0;
      let inLinks = 0;
      let checks = 0;
      for (; ; checks += 3) {
        stops.length = 0;
        const links = writtenLinksIn(STOPPED_TEXT, { ms: checks, now: fakeClock(), every: 1 });
        const stop = stops[0];
        expect(inOrderWithin(links, full)).toBe(true);
        const shown = links.map((link) => link.written);
        const targets = [
          ...linkTargetSet(STOPPED_TEXT, { limit: { ms: checks, now: fakeClock(), every: 1 } }),
        ];
        for (const hidden of HIDDEN) {
          expect(shown).not.toContain(hidden);
          expect(targets).not.toContain(hidden);
        }
        if (stop === undefined) break;
        expect(stop).toMatch(
          /^link text: stopped after \d+ ms in the \w+ pass at \d+ of \d+ characters$/,
        );
        if (links.length > 0 && links.length < full.length) partial++;
        const where = /in the (\w+) pass at (\d+) of/.exec(stop);
        if (where?.[1] !== "links") continue;
        inLinks++;
        const cut = Number(where[2]);
        const kept = STOPPED_TEXT.lastIndexOf("\n\n", cut - 1);
        for (const link of links) expect(link.at).toBeLessThan(cut);
        for (const link of full.filter((l) => l.at < kept && STOPPED_TEXT[l.at] === "]")) {
          expect(links).toContainEqual(link);
        }
      }
      expect(partial).toBeGreaterThan(0);
      expect(inLinks).toBeGreaterThan(0);
      expect(writtenLinksIn(STOPPED_TEXT, { ms: checks, now: fakeClock(), every: 1 })).toEqual(
        full,
      );
    },
    LONG_TEST_MS,
  );

  test("logs one line with the pass and the length, and no text", () => {
    stops.length = 0;
    expect(writtenLinksIn(STOPPED_TEXT, { ms: 0, now: fakeClock(), every: 1 })).toEqual([]);
    expect(stops).toEqual([
      `link text: stopped after 2 ms in the lines pass at 0 of ${STOPPED_TEXT.length} characters`,
    ]);
  });

  test(
    "leaves a normal text alone under the default limit",
    () => {
      let text = "";
      for (let i = 0; text.length < 1_000_000; i++) {
        text += `# Part ${i}\n\nSee [a](C:/a${i}.png), \`code\` and <!-- note -->.\n\n\`\`\`\n[x](C:/x.png)\n\`\`\`\n\n`;
      }
      expect(LINK_TEXT_TIME_LIMIT_MS).toBeGreaterThanOrEqual(BOUND_MS);
      expect(writtenLinksIn(text).length).toBe(text.split("# Part").length - 1);
      expect(stops).toEqual([]);
    },
    LONG_TEST_MS,
  );
});
