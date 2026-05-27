/**
 * Unit tests for formatDiffRef / formatDiffRefPair in
 * src/renderer/components/editor/format-diff-refs.ts.
 *
 * SCOPE:
 *   - EMPTY_TREE sentinel → "∅".
 *   - Special refs (HEAD / INDEX / WORKING) survive untouched.
 *   - 40-char hex SHA → first 7 chars.
 *   - Non-SHA refs (branch names, HEAD~1, tags) survive untouched.
 *   - Pair formatter uses "A..B" notation.
 *
 * ISOLATION: pure functions, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { EMPTY_TREE } from "../../../../../src/renderer/components/editor/diff-refs";
import {
  formatDiffRef,
  formatDiffRefPair,
} from "../../../../../src/renderer/components/editor/format-diff-refs";

describe("formatDiffRef", () => {
  test("renders EMPTY_TREE sentinel as ∅", () => {
    expect(formatDiffRef(EMPTY_TREE)).toBe("∅");
  });

  test("leaves HEAD / INDEX / WORKING untouched", () => {
    expect(formatDiffRef("HEAD")).toBe("HEAD");
    expect(formatDiffRef("INDEX")).toBe("INDEX");
    expect(formatDiffRef("WORKING")).toBe("WORKING");
  });

  test("abbreviates 40-char hex SHA to 7 chars", () => {
    expect(formatDiffRef("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBe("a1b2c3d");
  });

  test("abbreviates 7-char-plus hex SHA to 7 chars", () => {
    expect(formatDiffRef("a1b2c3d4")).toBe("a1b2c3d");
  });

  test("treats sha-like input case-insensitively", () => {
    expect(formatDiffRef("ABCDEF0")).toBe("ABCDEF0");
    expect(formatDiffRef("ABCDEF0AAAAAA")).toBe("ABCDEF0");
  });

  test("leaves branch / tag / parent-of names untouched", () => {
    expect(formatDiffRef("main")).toBe("main");
    expect(formatDiffRef("feature/foo")).toBe("feature/foo");
    expect(formatDiffRef("HEAD~1")).toBe("HEAD~1");
    expect(formatDiffRef("HEAD^")).toBe("HEAD^");
    expect(formatDiffRef("v1.2.3")).toBe("v1.2.3");
  });

  test("does not abbreviate hex shorter than 7 chars", () => {
    // SHA_LIKE_RE requires 7+ hex chars so this falls through to "return as-is".
    expect(formatDiffRef("abcdef")).toBe("abcdef");
  });
});

describe("formatDiffRefPair", () => {
  test("joins refs with the git two-dot range operator", () => {
    expect(formatDiffRefPair("HEAD", "WORKING")).toBe("HEAD..WORKING");
    expect(formatDiffRefPair("INDEX", "WORKING")).toBe("INDEX..WORKING");
  });

  test("formats each side independently", () => {
    expect(formatDiffRefPair(EMPTY_TREE, "HEAD")).toBe("∅..HEAD");
    expect(
      formatDiffRefPair(
        "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        "fedcba9876543210fedcba9876543210fedcba98",
      ),
    ).toBe("a1b2c3d..fedcba9");
  });
});
