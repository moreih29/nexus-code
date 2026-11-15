/** A thinking block in a Claude tab: folded, and unfoldable only when it has text. */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { Thinking } = await import("../../../../../src/renderer/components/chat/message-list");

describe("a thinking block", () => {
  test("with a summary: a button that unfolds it", () => {
    const html = renderToStaticMarkup(<Thinking text="Weighing 9.11 against 9.9" />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Thinking<");
  });

  test("with its text left out by the API: the label alone, nothing to unfold", () => {
    for (const text of ["", " \n"]) {
      const html = renderToStaticMarkup(<Thinking text={text} />);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("aria-expanded");
      expect(html).toContain(">Thinking<");
    }
    expect(renderToStaticMarkup(<Thinking text="" live />)).toContain("animate-pulse");
  });
});
