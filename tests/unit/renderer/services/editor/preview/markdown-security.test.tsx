/**
 * MarkdownPreview — security regression suite (plan 60 issue 1).
 *
 * The premise: workspace markdown is UNTRUSTED. The component must:
 *
 *   1. Never render raw `<script>` from the source as an executable script tag.
 *   2. Never honour scheme-prefixed links outside the allowlist (javascript:,
 *      file:, vscode:, data:) — these become disabled `<a>` elements that
 *      block on click and log a warning.
 *   3. Rewrite workspace-relative image src to `nexus-workspace://` URLs.
 *   4. Truncate sources larger than `MAX_PREVIEW_BYTES` and surface a banner.
 *
 * These tests stub the renderer modules that pull in IPC / openOrRevealEditor
 * so they can run under `bun test` without an Electron host.
 */

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../../../../../../src/renderer/services/editor", () => ({
  openOrRevealEditor: mock(() => {}),
}));

mock.module("../../../../../../src/shared/log/renderer", () => ({
  createLogger: () => ({
    warn: mock(() => {}),
    info: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}));

const { MarkdownPreview } = await import(
  "../../../../../../src/renderer/components/editor/preview/markdown-preview"
);
const { MAX_PREVIEW_BYTES, PREVIEW_TRUNCATED_MESSAGE } = await import(
  "../../../../../../src/renderer/components/editor/preview/constants"
);

const BASE_PROPS = {
  workspaceId: "ws-1",
  currentFileAbsPath: "/workspace/proj/docs/README.md",
  workspaceRootAbsPath: "/workspace/proj",
};

describe("MarkdownPreview — XSS / script suppression", () => {
  test("raw <script> in the source is rendered as text, not as a script element", () => {
    const source = "Normal text.\n\n<script>alert(1)</script>\n\nMore text.";
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={source} />,
    );
    // No actual <script> tag — react-markdown without rehype-raw escapes raw HTML.
    expect(html).not.toContain("<script>");
    // …but the HTML-escaped form IS present, proving the input was treated
    // as text. Escaped text in a paragraph is inert.
    expect(html).toContain("&lt;script&gt;");
  });

  test("inline <iframe> in the source is similarly escaped", () => {
    const source = "<iframe src='https://evil.example'></iframe>";
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={source} />,
    );
    expect(html).not.toContain("<iframe");
  });
});

describe("MarkdownPreview — disallowed link schemes", () => {
  test("`javascript:` href on a link is NOT placed into href attribute (sanitiser strips it)", () => {
    const source = "[click](javascript:alert(1))";
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={source} />,
    );
    // react-markdown's default `urlTransform` strips `javascript:` URLs to "".
    expect(html).not.toContain("javascript:alert");
  });

  test("`data:` images do not propagate into img src", () => {
    const source = "![evil](data:text/html,<script>alert(1)</script>)";
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={source} />,
    );
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("alert(1)");
  });
});

describe("MarkdownPreview — workspace image rewriting", () => {
  test("relative image src is rewritten to nexus-workspace:// URL", () => {
    const source = "![logo](./img/logo.png)";
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={source} />,
    );
    // workspace-root prefix + relative path → nexus-workspace://<id>/docs/img/logo.png
    expect(html).toContain("nexus-workspace://ws-1/docs/img/logo.png");
    expect(html).toContain('alt="logo"');
  });

  test("escape attempt outside workspace renders inline [image] placeholder", () => {
    const source = "![secret](../../../etc/shadow)";
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={source} />,
    );
    expect(html).not.toContain("nexus-workspace://");
    expect(html).toContain("[image]");
  });
});

describe("MarkdownPreview — byte cap", () => {
  test("source exceeding MAX_PREVIEW_BYTES surfaces the truncate banner", () => {
    const oversized = "x".repeat(MAX_PREVIEW_BYTES + 1);
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={oversized} />,
    );
    expect(html).toContain(PREVIEW_TRUNCATED_MESSAGE);
  });

  test("source under MAX_PREVIEW_BYTES does not render the banner", () => {
    const source = "# small";
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={source} />,
    );
    expect(html).not.toContain(PREVIEW_TRUNCATED_MESSAGE);
  });
});
