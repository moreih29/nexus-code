/**
 * ReadOnlyBanner component tests.
 *
 * Uses renderToStaticMarkup for text/structure assertions.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadOnlyBanner } from "../../../../../../src/renderer/components/workspace/content/read-only-banner";

describe("ReadOnlyBanner", () => {
  test("renders read-only label text", () => {
    const html = renderToStaticMarkup(
      createElement(ReadOnlyBanner, { filePath: "/some/path/file.ts" }),
    );
    expect(html).toContain("Read-only");
    expect(html).toContain("external source");
  });

  test("renders Reveal in Finder button when onRevealInFinder is provided", () => {
    const handler = mock(() => {});
    const html = renderToStaticMarkup(
      createElement(ReadOnlyBanner, {
        filePath: "/some/path/file.ts",
        onRevealInFinder: handler,
      }),
    );
    expect(html).toContain("Reveal in Finder");
  });

  test("does NOT render Reveal in Finder button when onRevealInFinder is absent", () => {
    const html = renderToStaticMarkup(
      createElement(ReadOnlyBanner, { filePath: "/some/path/file.ts" }),
    );
    expect(html).not.toContain("Reveal in Finder");
  });
});
