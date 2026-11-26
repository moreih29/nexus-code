import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "../../../../../src/renderer/components/chat/chat-markdown";

function render(text: string): string {
  return renderToStaticMarkup(<ChatMarkdown text={text} workspaceId="ws" cwd="/w" rootPath="/w" />);
}

describe("a network path an answer links", () => {
  test("stays a link, so a click can say it is not opened", () => {
    const html = render("See [share](//server/share/a.txt).");
    expect(html).toContain('href="//server/share/a.txt"');
  });

  test.each([
    [String.raw`\\\\.\\C:\\tmp\\a.txt`, "%5C%5C.%5CC:%5Ctmp%5Ca.txt"],
    [String.raw`\\\\?\\C:\\tmp\\a.txt`, "%5C%5C?%5CC:%5Ctmp%5Ca.txt"],
    ["%5C%5Cserver%5Cshare%5Ca.txt", "%5C%5Cserver%5Cshare%5Ca.txt"],
    ["file://server/share/a.txt", "file://server/share/a.txt"],
  ])("preserves %s as a clickable file link", (target, href) => {
    expect(render(`See [file](${target}).`)).toContain(`href="${href}"`);
  });

  test("keeps unsafe URL schemes blocked", () => {
    const html = render("See [script](javascript:alert%281%29) and [site](https://example.com).");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
  });

  test.each([
    "javascript:alert%281%29",
    "JaVaScRiPt:alert%281%29",
    "data:text/html,%3Cscript%3Ealert(1)%3C/script%3E",
    "vbscript:msgbox(1)",
    "file:javascript:alert(1)",
  ])("keeps %s blocked", (target) => {
    const html = render(`See [x](${target}).`);
    expect(html.toLowerCase()).not.toMatch(/href="(?:javascript|data|vbscript|file:javascript):/);
  });

  test.each([
    ["/%3F%3F/UNC/127.0.0.1/qa-none-46/a.txt", "/%3F%3F/UNC/127.0.0.1/qa-none-46/a.txt"],
    ["%5C%3F%3F%5CUNC%5Cs%5Csh%5Ca.txt", "%5C%3F%3F%5CUNC%5Cs%5Csh%5Ca.txt"],
    ["file:%5C%5Cserver%5Cshare%5Ca.txt", "file:%5C%5Cserver%5Cshare%5Ca.txt"],
    ["%5C%5Cserver:80%5Cx%5Ca.txt", "%5C%5Cserver:80%5Cx%5Ca.txt"],
  ])("keeps %s a link without looking it up", (target, href) => {
    const html = render(`See [file](${target}).`);
    expect(html).toContain("<a ");
    expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain("<svg");
  });

  test("while a file not found yet is plain text", () => {
    const html = render("See [gone](/tmp/qa-none/a.txt).");
    expect(html).not.toContain("<a ");
  });

  test.each([
    "%5C%5C.%5CC:%5Ca.png",
    "/%3F%3F/UNC/s/sh/a.png",
    "//server/share/a.png",
  ])("as an image at %s, is its name and never loaded", (src) => {
    const html = render(`![shot](${src})`);
    expect(html).not.toContain("<img");
    expect(html).toContain("shot");
  });

  test("as an image, is its name and never loaded", () => {
    const html = render("![shot](//server/share/a.png)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("server/share");
  });
});
