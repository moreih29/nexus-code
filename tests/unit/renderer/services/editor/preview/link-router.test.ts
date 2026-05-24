import { describe, expect, it } from "bun:test";
import {
  classifyLinkHref,
  __testing,
} from "../../../../../../src/renderer/services/editor/preview/link-router";

const CTX = {
  currentFileAbsPath: "/work/proj/docs/README.md",
  workspaceRootAbsPath: "/work/proj",
};

describe("classifyLinkHref — anchors", () => {
  it("treats #foo as an anchor for link kind", () => {
    expect(classifyLinkHref("#intro", CTX)).toEqual({ kind: "anchor", id: "intro" });
  });

  it("blocks anchor href on image kind (an image cannot scroll the preview)", () => {
    const out = classifyLinkHref("#intro", { ...CTX, kind: "image" });
    expect(out.kind).toBe("blocked");
  });
});

describe("classifyLinkHref — external schemes (allowlist)", () => {
  it("classifies http/https/mailto as external", () => {
    expect(classifyLinkHref("http://example.com", CTX).kind).toBe("external");
    expect(classifyLinkHref("https://example.com/x?y=1", CTX).kind).toBe("external");
    expect(classifyLinkHref("mailto:a@b.com", CTX).kind).toBe("external");
  });

  it("blocks scheme-prefixed hrefs outside the allowlist", () => {
    expect(classifyLinkHref("javascript:alert(1)", CTX).kind).toBe("blocked");
    expect(classifyLinkHref("data:text/html,<x>", CTX).kind).toBe("blocked");
    expect(classifyLinkHref("file:///etc/passwd", CTX).kind).toBe("blocked");
    expect(classifyLinkHref("vscode://open?path=/a", CTX).kind).toBe("blocked");
    expect(classifyLinkHref("cursor://open", CTX).kind).toBe("blocked");
  });
});

describe("classifyLinkHref — internal workspace files", () => {
  it("resolves a sibling relative path to internal-file with workspace-relative path", () => {
    const out = classifyLinkHref("./guide.md", CTX);
    expect(out).toEqual({
      kind: "internal-file",
      absPath: "/work/proj/docs/guide.md",
      relPath: "docs/guide.md",
    });
  });

  it("resolves a parent-traversal path that stays inside the workspace", () => {
    const out = classifyLinkHref("../README.md", CTX);
    expect(out).toEqual({
      kind: "internal-file",
      absPath: "/work/proj/README.md",
      relPath: "README.md",
    });
  });

  it("resolves a bare filename (no leading ./) to the same directory", () => {
    const out = classifyLinkHref("notes.md", CTX);
    expect(out).toEqual({
      kind: "internal-file",
      absPath: "/work/proj/docs/notes.md",
      relPath: "docs/notes.md",
    });
  });
});

describe("classifyLinkHref — escape attempts (CRITICAL)", () => {
  it("blocks ../.. escape past the workspace root", () => {
    expect(classifyLinkHref("../../../etc/passwd", CTX).kind).toBe("blocked");
  });

  it("blocks an accidentally absolute path outside the root", () => {
    expect(classifyLinkHref("/etc/passwd", CTX).kind).toBe("blocked");
  });

  it("blocks paths that look like a prefix but live in a sibling directory", () => {
    // /work/projectX is NOT inside /work/proj
    const ctx2 = { ...CTX, currentFileAbsPath: "/work/projectX/notes/main.md" };
    expect(classifyLinkHref("./aux.md", ctx2).kind).toBe("blocked");
  });
});

describe("classifyLinkHref — empty / malformed", () => {
  it("blocks empty href", () => {
    expect(classifyLinkHref("", CTX).kind).toBe("blocked");
  });
});

describe("hasUrlScheme (internal helper)", () => {
  it("matches RFC 3986 scheme heads", () => {
    const { hasUrlScheme } = __testing;
    expect(hasUrlScheme("http://x")).toBe(true);
    expect(hasUrlScheme("HTTPS://x")).toBe(true);
    expect(hasUrlScheme("custom-app+v2.0:x")).toBe(true);
    expect(hasUrlScheme("./foo.md")).toBe(false);
    expect(hasUrlScheme("foo.md")).toBe(false);
    expect(hasUrlScheme("/abs/path")).toBe(false);
    expect(hasUrlScheme("#anchor")).toBe(false);
  });
});
