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

  it("keeps unrelated siblings — neither is a prefix of the other", () => {
    const result = distinctParents(["/repo/a.ts", "/repo/b.ts"]);
    expect(result).toHaveLength(2);
    expect(result).toContain("/repo/a.ts");
    expect(result).toContain("/repo/b.ts");
  });

  it("does NOT drop /foobar when /foo is in the list (root prefix collision guard)", () => {
    const result = distinctParents(["/foo", "/foobar"]);
    expect(result).toHaveLength(2);
    expect(result).toContain("/foo");
    expect(result).toContain("/foobar");
  });

  it("handles the full mixed case: parent + children + duplicates + siblings", () => {
    const input = ["/repo/src/a.ts", "/repo/src", "/repo/src", "/repo/lib/b.ts", "/repo/lib"];
    const result = distinctParents(input);
    expect(result).toHaveLength(2);
    expect(result).toContain("/repo/src");
    expect(result).toContain("/repo/lib");
  });
});
