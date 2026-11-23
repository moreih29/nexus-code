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

const BASE_PROPS = {
  workspaceId: "ws-1",
  currentFileAbsPath: "/workspace/proj/docs/README.md",
  workspaceRootAbsPath: "/workspace/proj",
};

describe("MarkdownPreview — XSS / script suppression", () => {
  test("raw <script> is stripped entirely — tag and inline code both gone", () => {
    const source = "Normal text.\n\n<script>alert(1)</script>\n\nMore text.";
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("&lt;script&gt;");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("Normal text.");
    expect(html).toContain("More text.");
  });

  test("inline <iframe> is removed by the sanitiser", () => {
    const source = "<iframe src='https://evil.example'></iframe>";
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example");
  });

  test("an inline event handler (onerror) is stripped from a raw <img>", () => {
    const source = '<img src="x" onerror="alert(1)" />';
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });
});

describe("MarkdownPreview — disallowed link schemes", () => {
  test("`javascript:` href on a link is NOT placed into href attribute (sanitiser strips it)", () => {
    const source = "[click](javascript:alert(1))";
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html).not.toContain("javascript:alert");
  });

  test("`data:` images do not propagate into img src", () => {
    const source = "![evil](data:text/html,<script>alert(1)</script>)";
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("alert(1)");
  });
});

describe("MarkdownPreview — workspace image rewriting", () => {
  test("relative image src is rewritten to nexus-workspace:// URL", () => {
    const source = "![logo](./img/logo.png)";
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html).toContain("nexus-workspace://ws-1/docs/img/logo.png");
    expect(html).toContain('alt="logo"');
  });

  test("escape attempt outside workspace renders the image's name in its place", () => {
    const source = "![secret](../../../etc/shadow)";
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html).not.toContain("nexus-workspace://");
    expect(html).not.toContain("<img");
    expect(html).toContain("[secret]");
  });
});

describe("MarkdownPreview — YAML frontmatter", () => {
  describe("stripFrontmatter — unit", () => {
    test("strips a CRLF-terminated frontmatter block", () => {
      const src = "---\r\nfoo: bar\r\n---\r\nbody\r\n";
      expect(stripFrontmatter(src)).toBe("body\r\n");
    });

    test("leaves an empty `---\\n---` block intact (no YAML signature → fall through)", () => {
      const src = "---\n---\nbody";
      expect(stripFrontmatter(src)).toBe(src);
    });

    test("leaves a markdown body that happens to sit between two `---` intact (user typing case)", () => {
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

describe("MarkdownPreview — non-ASCII image paths", () => {
  test("encodes a Korean image name once in the workspace URL", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview {...BASE_PROPS} source={"![plot](이미지.png)"} />,
    );
    expect(html).toContain('src="nexus-workspace://ws-1/docs/%EC%9D%B4%EB%AF%B8%EC%A7%80.png"');
    expect(html).not.toContain("%25EC");
  });
});
