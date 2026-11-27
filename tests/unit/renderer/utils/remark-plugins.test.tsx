import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { REMARK_PLUGINS, writtenHrefOf } from "../../../../src/renderer/utils/remark-plugins";

const render = (text: string) =>
  renderToStaticMarkup(<ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>);

describe("REMARK_PLUGINS", () => {
  test("a single tilde is text, so ranges stay ranges", () => {
    const html = render("16:02~16:09에 0.5GB에서 1.28GB로, CPU를 50~70%");
    expect(html).not.toContain("<del>");
    expect(html).toContain("16:02~16:09");
    expect(html).toContain("50~70%");
  });

  test("two tildes still strike text out", () => {
    expect(render("~~gone~~ stays")).toContain("<del>gone</del>");
  });

  test("the rest of GitHub-flavored markdown still works", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\nhttps://example.com");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<a href="https://example.com">');
  });
});

const links = (text: string) => {
  const seen: { href: string | undefined; written: string | undefined }[] = [];
  const keep = ({ node, href, src }: { node?: unknown; href?: string; src?: string }) => {
    const url = href ?? src;
    seen.push({ href: url && decodeURIComponent(url), written: writtenHrefOf(node) });
    return null;
  };
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={(url) => url}
      components={{ a: keep, img: keep }}
    >
      {text}
    </ReactMarkdown>,
  );
  return seen;
};

describe("remarkWrittenLinks", () => {
  test.each([
    [
      String.raw`[a](C:\x\.y.png "t")`,
      [{ href: String.raw`C:\x\.y.png`, written: String.raw`C:\x\.y.png` }],
    ],
    [
      String.raw`![a](<C:\a b\.c.png>)`,
      [{ href: String.raw`C:\a b\.c.png`, written: String.raw`C:\a b\.c.png` }],
    ],
    [
      String.raw`[a](/tmp/\_x.md#L3)`,
      [{ href: "/tmp/_x.md#L3", written: String.raw`/tmp/\_x.md` }],
    ],
    [
      `[a][r] and ![b][r]\n\n${String.raw`[r]: C:\x\.y.png:12`}`,
      [
        { href: String.raw`C:\x\.y.png:12`, written: String.raw`C:\x\.y.png` },
        { href: String.raw`C:\x\.y.png:12`, written: String.raw`C:\x\.y.png` },
      ],
    ],
    [
      String.raw`[a](C:\x(1) "](C:\Users\me\.ssh\id.png")`,
      [{ href: String.raw`C:\x(1)`, written: String.raw`C:\x(1)` }],
    ],
    [String.raw`[a](C:\x\.y&copy;.png)`, [{ href: "C:\\x.y\u00a9.png", written: undefined }]],
    ["[a](javascript:alert(1))", [{ href: "javascript:alert(1)", written: undefined }]],
    ["see https://example.com/a", [{ href: "https://example.com/a", written: undefined }]],
  ])("%s", (text, expected) => {
    expect(links(text)).toEqual(expected);
  });
});
