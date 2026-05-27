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

const { MarkdownPreview, stripFrontmatter } = await import(
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

describe("MarkdownPreview — YAML frontmatter", () => {
  test("a leading `---` YAML block is stripped from the rendered output", () => {
    const source = [
      "---",
      "title: Hello",
      "tags: [a, b]",
      "---",
      "",
      "# Body heading",
      "",
      "Body paragraph.",
    ].join("\n");
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html).not.toContain("title: Hello");
    expect(html).not.toContain("tags:");
    expect(html).toContain("Body heading");
    expect(html).toContain("Body paragraph.");
  });

  test("a thematic break (`---`) deeper in the document is preserved (not treated as frontmatter)", () => {
    const source = ["# Heading", "", "Para one.", "", "---", "", "Para two."].join("\n");
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    // The body must survive; an <hr> remains where the thematic break was.
    expect(html).toContain("Para one.");
    expect(html).toContain("Para two.");
    expect(html).toContain("<hr");
  });

  describe("stripFrontmatter — unit", () => {
    test("strips a CRLF-terminated frontmatter block", () => {
      const src = "---\r\nfoo: bar\r\n---\r\nbody\r\n";
      expect(stripFrontmatter(src)).toBe("body\r\n");
    });

    test("leaves an empty `---\\n---` block intact (no YAML signature → fall through)", () => {
      // Two adjacent `---` lines are indistinguishable from two thematic
      // breaks. The signature guard makes us prefer the safer
      // interpretation: render as `<hr><hr>`, do not silently swallow the
      // body below.
      const src = "---\n---\nbody";
      expect(stripFrontmatter(src)).toBe(src);
    });

    test("leaves a markdown body that happens to sit between two `---` intact (user typing case)", () => {
      // The motivating case: a live-preview user typing
      //   ---
      //   # title
      //   ---
      // must NOT have `# title` disappear. No `key:` line → guard rejects.
      const src = "---\n# title\n---\nmore";
      expect(stripFrontmatter(src)).toBe(src);
    });

    test("leaves a list/paragraph between two `---` intact (no YAML key)", () => {
      const src = "---\n- item one\n- item two\n---\nbody";
      expect(stripFrontmatter(src)).toBe(src);
    });

    test("strips when the YAML body contains at least one `key: value` line, even alongside comments", () => {
      const src = "---\n# a yaml comment\ntitle: hello\n---\nbody";
      expect(stripFrontmatter(src)).toBe("body");
    });

    test("strips when the YAML key is a non-ASCII identifier (Hangul)", () => {
      const src = "---\n제목: 안녕하세요\n---\nbody";
      expect(stripFrontmatter(src)).toBe("body");
    });

    test("strips when the YAML key is a non-ASCII identifier (Hiragana / mixed)", () => {
      const src = "---\nタイトル: hello\nauthor: 김\n---\nbody";
      expect(stripFrontmatter(src)).toBe("body");
    });

    test("does NOT confuse a `-` list marker with a YAML key (first char must be letter or `_`)", () => {
      const src = "---\n- item one\n-key: still not a key\n---\nbody";
      expect(stripFrontmatter(src)).toBe(src);
    });

    test("strips when the document ends exactly at the closing fence", () => {
      expect(stripFrontmatter("---\nfoo: bar\n---")).toBe("");
    });

    test("tolerates a leading UTF-8 BOM before the opening fence", () => {
      expect(stripFrontmatter("﻿---\nfoo: bar\n---\nbody")).toBe("body");
    });

    test("does NOT strip a `---` that is not at byte 0", () => {
      const src = "intro\n---\nfoo: bar\n---\nbody";
      expect(stripFrontmatter(src)).toBe(src);
    });

    test("does NOT strip if the opening fence has trailing whitespace", () => {
      const src = "--- \nfoo: bar\n---\nbody";
      expect(stripFrontmatter(src)).toBe(src);
    });

    test("is a no-op when no frontmatter is present", () => {
      const src = "# heading\n\nparagraph";
      expect(stripFrontmatter(src)).toBe(src);
    });
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
