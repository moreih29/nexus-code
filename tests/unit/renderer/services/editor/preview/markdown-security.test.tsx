import { describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { withTestDom } from "../../../../../helpers/test-dom";

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

describe("MarkdownPreview — link data stays off the page", () => {
  test("no written target or syntax node on an anchor or an image", () => {
    const source = String.raw`See [a](C:\x\.y.txt), [b](docs/b.md), [r] and ![i](./img/i.png).

[r]: C:\r\.png`;
    const html = renderToStaticMarkup(<MarkdownPreview {...BASE_PROPS} source={source} />);
    expect(html.match(/<a /g)?.length).toBe(3);
    expect(html).toContain("<img");
    expect(html).not.toMatch(/data-written-href|datawrittenhref/i);
    expect(html).not.toMatch(/\snode=/);
  });
});

describe("MarkdownPreview — workspace image rewriting", () => {
  test("relative image src follows the same file across edits and reopens", async () => {
    await withTestDom(async (host, root) => {
      let version = "old";
      let changed: ((event: unknown) => void) | undefined;
      const reads: unknown[] = [];
      Object.assign(window, {
        ipc: {
          call: async (channel: string, method: string, args: unknown) => {
            reads.push({ channel, method, args });
            return { kind: "ok", base64: "", sizeBytes: 16, mtime: "same", version };
          },
          listen: (channel: string, event: string, callback: (value: unknown) => void) => {
            if (channel === "fs" && event === "changed") changed = callback;
            return () => {};
          },
        },
      });
      const source = "![logo](./img/logo.png)";
      const render = (key: string) =>
        root.render(<MarkdownPreview key={key} {...BASE_PROPS} source={source} />);
      const src = () => host.querySelector("img")?.getAttribute("src");
      const change = () =>
        changed?.({ workspaceId: "ws-1", changes: [{ relPath: "docs/img/logo.png" }] });

      await act(async () => render("first"));
      expect(src()).toBe("nexus-workspace://ws-1/docs/img/logo.png?v=old");
      expect(host.querySelector("img")?.getAttribute("alt")).toBe("logo");

      await act(async () => render("second"));
      expect(src()).toBe("nexus-workspace://ws-1/docs/img/logo.png?v=old");

      version = "new";
      await act(async () => change());
      expect(src()).toBe("nexus-workspace://ws-1/docs/img/logo.png?v=new");
      await act(async () => render("third"));
      expect(src()).toBe("nexus-workspace://ws-1/docs/img/logo.png?v=new");
      expect(reads).toEqual(
        Array.from({ length: 4 }, () => ({
          channel: "fs",
          method: "readRange",
          args: { workspaceId: "ws-1", relPath: "docs/img/logo.png", offset: 0, length: 0 },
        })),
      );
    });
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
  test("encodes a Korean image name once in the workspace URL", async () => {
    await withTestDom(async (host, root) => {
      Object.assign(window, {
        ipc: {
          call: async () => ({ kind: "ok", version: "v1" }),
          listen: () => () => {},
        },
      });
      await act(async () =>
        root.render(<MarkdownPreview {...BASE_PROPS} source="![plot](이미지.png)" />),
      );
      expect(host.querySelector("img")?.getAttribute("src")).toBe(
        "nexus-workspace://ws-1/docs/%EC%9D%B4%EB%AF%B8%EC%A7%80.png?v=v1",
      );
    });
  });
});
