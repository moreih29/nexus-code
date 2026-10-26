import { describe, expect, test } from "bun:test";
import { classifyLinkHref } from "../../../../../../src/renderer/services/editor/preview/link-router";

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
