import { describe, expect, test } from "bun:test";
import {
  buildPreviewDocument,
  leadingDoctypeEnd,
  previewSafeHtml,
  previewScopeCandidates,
  STANDARD_DOCTYPE,
  scopedBase,
} from "../../../../../../src/renderer/services/editor/preview/html-document";

const HEAD = "<base href=x>";
const BOM = String.fromCharCode(0xfeff);

describe("leadingDoctypeEnd", () => {
  test("finds the DOCTYPE that opens a page, past whitespace and comments", () => {
    expect(leadingDoctypeEnd("<!DOCTYPE html><p>")).toBe(15);
    expect(leadingDoctypeEnd("<!doctype html>")).toBe(15);
    const page = [BOM, "  <!-- a --><!-- b -->", "<!DocType html>"].join("\n");
    expect(leadingDoctypeEnd(`${page}<p>`)).toBe(page.length);
  });

  test("finds none when something else opens the page", () => {
    expect(leadingDoctypeEnd("<html><!DOCTYPE html>")).toBe(-1);
    expect(leadingDoctypeEnd("text <!DOCTYPE html>")).toBe(-1);
    expect(leadingDoctypeEnd("<!-- never closed <!DOCTYPE html>")).toBe(-1);
    expect(leadingDoctypeEnd("")).toBe(-1);
  });
});

describe("buildPreviewDocument", () => {
  test("puts the head before anything of the page's, so it runs before the page's scripts", () => {
    const page = '<!DOCTYPE html><html><script>a()</script><head lang="en"><title>t</title>';
    expect(buildPreviewDocument(page, HEAD)).toBe(
      `<!DOCTYPE html>${HEAD}<html><script>a()</script><head lang="en"><title>t</title>`,
    );
  });

  test("gives a page without a DOCTYPE the standard one, as srcdoc rendered it", () => {
    expect(buildPreviewDocument("<html><head></head><body>x", HEAD)).toBe(
      `${STANDARD_DOCTYPE}${HEAD}<html><head></head><body>x`,
    );
    expect(buildPreviewDocument("<p>x</p>", HEAD)).toBe(`${STANDARD_DOCTYPE}${HEAD}<p>x</p>`);
  });

  test("keeps a page's own DOCTYPE first when it has no <head> tag", () => {
    expect(buildPreviewDocument("<!-- c --><!doctype html><title>t</title>", HEAD)).toBe(
      `<!-- c --><!doctype html>${HEAD}<title>t</title>`,
    );
  });

  test("does not take a <header> for the head", () => {
    expect(buildPreviewDocument("<!DOCTYPE html><header>h</header>", HEAD)).toBe(
      `<!DOCTYPE html>${HEAD}<header>h</header>`,
    );
  });
});

describe("previewSafeHtml", () => {
  test("keeps only style sheet links", () => {
    const page = [
      '<link rel="stylesheet" href="style.css">',
      "<link rel='alternate stylesheet' href=dark.css>",
      '<link rel="preload" href="https://x.test/a.js" as="script">',
      '<link rel="modulepreload" href="m.js">',
      '<link rel="prefetch" href="https://x.test/p">',
      '<link rel="prerender" href="https://x.test/r">',
      '<link rel="preconnect" href="https://x.test">',
      '<link rel="dns-prefetch" href="//x.test">',
      '<link rel="icon" href="https://x.test/i.png">',
      '<link rel="manifest" href="m.json">',
      '<link rel="stylesheet preload" href="both.css">',
      "<LINK REL=STYLESHEET HREF=upper.css>",
    ].join("");
    expect(previewSafeHtml(page)).toBe(
      '<link rel="stylesheet" href="style.css"><link rel=\'alternate stylesheet\' href=dark.css><LINK REL=STYLESHEET HREF=upper.css>',
    );
  });

  test("drops a refresh and the page's own base, and keeps other meta tags", () => {
    const page =
      '<meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://x.test"><META HTTP-EQUIV=Refresh content=1><base href="https://x.test/"><base target=_top><p>';
    expect(previewSafeHtml(page)).toBe('<meta charset="utf-8"><p>');
  });
});

describe("previewScopeCandidates", () => {
  test("a page in the workspace reads from the workspace's root, then its own folder", () => {
    expect(previewScopeCandidates("/w/docs/site/index.html", "/w")).toEqual([
      { dir: "/w", sub: "docs/site" },
      { dir: "/w/docs/site", sub: "" },
    ]);
    expect(previewScopeCandidates("/w/index.html", "/w/")).toEqual([
      { dir: "/w", sub: "" },
      { dir: "/w", sub: "" },
    ]);
    expect(previewScopeCandidates("C:\\w\\docs\\a.html", "C:\\w")).toEqual([
      { dir: "C:\\w", sub: "docs" },
      { dir: "C:\\w\\docs", sub: "" },
    ]);
  });

  test("a page outside the workspace reads only from its own folder", () => {
    expect(previewScopeCandidates("/tmp/r/index.html", "/w")).toEqual([{ dir: "/tmp/r", sub: "" }]);
    expect(previewScopeCandidates("/wx/index.html", "/w")).toEqual([{ dir: "/wx", sub: "" }]);
    expect(previewScopeCandidates("/tmp/r/index.html", "")).toEqual([{ dir: "/tmp/r", sub: "" }]);
  });
});

describe("scopedBase", () => {
  test("puts the page's folder under the root's address", () => {
    const base = "nexus-workspace://a.scope/";
    expect(scopedBase(base, "")).toBe(base);
    expect(scopedBase(base, "docs/my site")).toBe(`${base}docs/my%20site/`);
    expect(scopedBase(base, "문서/#1")).toBe(`${base}%EB%AC%B8%EC%84%9C/%231/`);
  });
});
