import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MarkdownBody,
  markdownText,
} from "../../../../../src/renderer/components/ui/markdown-body";

test("a code block keeps its text and gets the shared copy button", () => {
  const html = renderToStaticMarkup(<MarkdownBody source={"```ts\nconst a = 1;\n```"} />);
  expect(html).toContain("md-code-wrap");
  expect(html).toContain('aria-label="Copy code"');
  expect(html).toContain("hljs");
  expect(html).not.toContain("md-code-copy");
});

test("a code block with no language is not guessed at", () => {
  const html = renderToStaticMarkup(<MarkdownBody source={"```\nconst a = 1;\n```"} />);
  expect(html).not.toContain("hljs-keyword");
});

test("raw HTML is shown only when asked, and sanitised then", () => {
  const source = '<b>bold</b> <img src=x onerror="alert(1)">';
  expect(renderToStaticMarkup(<MarkdownBody source={source} />)).not.toContain("<b>");
  const html = renderToStaticMarkup(<MarkdownBody source={source} html />);
  expect(html).toContain("<b>bold</b>");
  expect(html).not.toContain("onerror");
});

test("web-only links open only http(s); images show their name", () => {
  const html = renderToStaticMarkup(
    <MarkdownBody
      source="[a](https://x.dev) [b](file:///etc/passwd) ![pic](p.png)"
      links="web-only"
    />,
  );
  expect(html).toContain('href="https://x.dev"');
  expect(html).not.toContain('href="file:');
  expect(html).toContain("[pic]");
  expect(html).not.toContain("<img");
});

test("markdownText joins a node's text", () => {
  expect(
    markdownText({
      tagName: "pre",
      children: [{ tagName: "code", children: [{ value: "a" }, { children: [{ value: "b" }] }] }],
    }),
  ).toBe("ab");
});

test("a task's checkbox in chat and the preview stays a disabled input", () => {
  const html = renderToStaticMarkup(<MarkdownBody source={"- [x] done\n- [ ] open"} />);
  expect(html.match(/<input[^>]*type="checkbox"[^>]*disabled=""/g)).toHaveLength(2);
});
