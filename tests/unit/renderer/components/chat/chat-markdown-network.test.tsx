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

  test("while a file not found yet is plain text", () => {
    const html = render("See [gone](/tmp/qa-none/a.txt).");
    expect(html).not.toContain("<a ");
  });

  test("as an image, is its name and never loaded", () => {
    const html = render("![shot](//server/share/a.png)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("server/share");
  });
});
