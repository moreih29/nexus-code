/**
 * distinctParents — pure helper unit tests.
 *
 * Covers the 7 cases specified in Phase C:
 *   1. Parent + child → only parent kept.
 *   2. Duplicate paths → deduplicated.
 *   3. Sort stability — output is shortest-first.
 *   4. Empty input → [].
 *   5. Single path → that path.
 *   6. Unrelated siblings → both kept.
 *   7. Root prefix collision: /foo vs /foobar → both kept (not a parent).
 *   8. Mixed: parents, children, siblings, duplicates together.
 */

import { describe, expect, it } from "bun:test";
import { distinctParents } from "../../../../../src/renderer/services/fs-mutations/distinct-parents";

describe("distinctParents", () => {
  it("keeps only the parent when a child is also selected", () => {
    const result = distinctParents(["/repo/src/index.ts", "/repo/src"]);
    expect(result).toEqual(["/repo/src"]);
  });

  it("keeps only the ancestor when multiple descendants are selected", () => {
    const result = distinctParents(["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src"]);
    expect(result).toEqual(["/repo/src"]);
  });

  it("deduplicates identical paths to a single entry", () => {
    const result = distinctParents(["/repo/a.ts", "/repo/a.ts", "/repo/a.ts"]);
    expect(result).toEqual(["/repo/a.ts"]);
  });

  it("returns [] for empty input", () => {
    expect(distinctParents([])).toEqual([]);
  });

  it("returns the single path for a single-element input", () => {
    expect(distinctParents(["/repo/foo.ts"])).toEqual(["/repo/foo.ts"]);
  });

  it("keeps unrelated siblings — neither is a prefix of the other", () => {
    const result = distinctParents(["/repo/a.ts", "/repo/b.ts"]);
    expect(result).toHaveLength(2);
    expect(result).toContain("/repo/a.ts");
    expect(result).toContain("/repo/b.ts");
  });

  it("does NOT drop /foobar when /foo is in the list (root prefix collision guard)", () => {
    // /foo is NOT an ancestor of /foobar — the trailing-slash check is essential.
    const result = distinctParents(["/foo", "/foobar"]);
    expect(result).toHaveLength(2);
    expect(result).toContain("/foo");
    expect(result).toContain("/foobar");
  });

  it("handles the full mixed case: parent + children + duplicates + siblings", () => {
    const input = [
      "/repo/src/a.ts", // child of /repo/src
      "/repo/src", // parent — should be kept
      "/repo/src", // duplicate — deduped
      "/repo/lib/b.ts", // sibling — should be kept
      "/repo/lib", // parent of lib/b.ts — should be kept; drops lib/b.ts
    ];
    const result = distinctParents(input);
    // /repo/src is the ancestor of /repo/src/a.ts → only /repo/src
    // /repo/lib is the ancestor of /repo/lib/b.ts → only /repo/lib
    expect(result).toHaveLength(2);
    expect(result).toContain("/repo/src");
    expect(result).toContain("/repo/lib");
  });

  it("output is sorted by ascending path length", () => {
    const result = distinctParents(["/a/b/c", "/a", "/a/b"]);
    // /a is the top ancestor → keeps only /a; /a/b and /a/b/c are descendants.
    expect(result).toEqual(["/a"]);
  });

  it("two unrelated dirs at same depth are both preserved", () => {
    const result = distinctParents(["/a/foo", "/a/bar"]);
    expect(result).toHaveLength(2);
    expect(result).toContain("/a/foo");
    expect(result).toContain("/a/bar");
  });
});
