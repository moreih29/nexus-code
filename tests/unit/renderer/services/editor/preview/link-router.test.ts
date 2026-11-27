import { describe, expect, test } from "bun:test";
import {
  classifyLinkHref,
  linkTargetPath,
} from "../../../../../../src/renderer/services/editor/preview/link-router";

const ctx = {
  currentFileAbsPath: "/ws/docs/README.md",
  workspaceRootAbsPath: "/ws",
};

describe("classifyLinkHref — workspace paths in URL form", () => {
  test("decodes percent-encoded non-ASCII and spaces", () => {
    expect(classifyLinkHref("%ED%95%9C%EA%B8%80.md", ctx)).toEqual({
      kind: "internal-file",
      absPath: "/ws/docs/한글.md",
      relPath: "docs/한글.md",
    });
    expect(classifyLinkHref("my%20notes.md", ctx)).toMatchObject({
      absPath: "/ws/docs/my notes.md",
    });
  });

  test("drops the fragment and query from the file path", () => {
    expect(classifyLinkHref("guide.md#install", ctx)).toMatchObject({
      kind: "internal-file",
      absPath: "/ws/docs/guide.md",
    });
    expect(classifyLinkHref("x.md?y=1", ctx)).toMatchObject({ absPath: "/ws/docs/x.md" });
  });

  test("checks containment after decoding an encoded traversal", () => {
    expect(classifyLinkHref("%2E%2E/%2E%2E/etc/passwd", ctx).kind).toBe("blocked");
  });

  test("keeps a malformed escape as written", () => {
    expect(classifyLinkHref("100%.md", ctx)).toMatchObject({ absPath: "/ws/docs/100%.md" });
  });

  test("blocks a link that is only a query", () => {
    expect(classifyLinkHref("?tab=1", ctx).kind).toBe("blocked");
  });
});

describe("linkTargetPath — where a link in an opened file points, inside the workspace or not", () => {
  test("resolves a relative link against the file's folder, even out of the workspace", () => {
    expect(linkTargetPath("../../qa/x%20y.png", "/ws/docs/README.md")).toBe("/qa/x y.png");
    expect(linkTargetPath("img/a.png?raw#top", "/ws/docs/README.md")).toBe("/ws/docs/img/a.png");
  });

  test("keeps an absolute or drive path", () => {
    expect(linkTargetPath("/tmp/qa.png", "/ws/a.md")).toBe("/tmp/qa.png");
    expect(linkTargetPath("D:\\qa\\..\\x.png", "C:/w/a.md")).toBe("D:/x.png");
    expect(linkTargetPath("x.png", "C:/w/a.md")).toBe("C:/w/x.png");
  });

  test.each([
    ["C:/w/../../x.png", "C:/x.png"],
    ["C:%5C..%5C..%5Cb.png", "C:/b.png"],
    ["d:/../..", "D:/"],
    ["../../x.png", "C:/x.png"],
    [String.raw`\\srv\sh\..\..\x`, String.raw`\\srv\sh\..\..\x`],
  ])("keeps the root of %s", (href, expected) => {
    expect(linkTargetPath(href, "C:/w/a.md")).toBe(expected);
  });

  test("is nothing for a URL, an anchor or an empty link", () => {
    expect(linkTargetPath("https://example.com/a.png", "/ws/a.md")).toBeNull();
    expect(linkTargetPath("#top", "/ws/a.md")).toBeNull();
    expect(linkTargetPath("", "/ws/a.md")).toBeNull();
  });
});
