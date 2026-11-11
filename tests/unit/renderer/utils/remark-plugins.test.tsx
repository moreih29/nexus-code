import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { REMARK_PLUGINS } from "../../../../src/renderer/utils/remark-plugins";

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
