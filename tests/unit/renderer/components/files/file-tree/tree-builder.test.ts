/**
 * Unit tests for tree-builder.ts — buildPathTree and collectDescendantLeafPaths.
 */

import { describe, expect, it } from "bun:test";
import {
  buildPathTree,
  collectDescendantLeafPaths,
  type PathTreeNode,
} from "../../../../../../src/renderer/components/files/file-tree/tree-builder";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function childrenOf(node: PathTreeNode, relPath: string): PathTreeNode[] {
  function find(n: PathTreeNode): PathTreeNode | undefined {
    if (n.relPath === relPath) return n;
    for (const c of n.children ?? []) {
      const found = find(c);
      if (found) return found;
    }
  }
  const target = find(node);
  return target?.children ?? [];
}

// ---------------------------------------------------------------------------
// buildPathTree
// ---------------------------------------------------------------------------

describe("buildPathTree", () => {
  it("paths empty → root with no children", () => {
    const root = buildPathTree([]);
    expect(root.kind).toBe("dir");
    expect(root.name).toBe("");
    expect(root.relPath).toBe("");
    expect(root.depth).toBe(0);
    expect(root.children).toEqual([]);
  });

  it("paths flat (root files only)", () => {
    const root = buildPathTree(["a.ts", "b.ts", "c.ts"]);
    expect(root.children).toHaveLength(3);
    const names = root.children!.map((c) => c.name);
    expect(names).toEqual(["a.ts", "b.ts", "c.ts"]);
    for (const child of root.children!) {
      expect(child.kind).toBe("file");
      expect(child.depth).toBe(1);
    }
  });

  it("paths nested → dir 중첩 트리", () => {
    const root = buildPathTree(["src/utils/helper.ts", "src/index.ts", "README.md"]);

    // Top level: src (dir), README.md (file) — dirs first.
    expect(root.children).toHaveLength(2);
    expect(root.children![0].name).toBe("src");
    expect(root.children![0].kind).toBe("dir");
    expect(root.children![1].name).toBe("README.md");
    expect(root.children![1].kind).toBe("file");

    // src children: utils (dir), index.ts (file).
    const srcChildren = childrenOf(root, "src");
    expect(srcChildren).toHaveLength(2);
    expect(srcChildren[0].name).toBe("utils");
    expect(srcChildren[0].kind).toBe("dir");
    expect(srcChildren[1].name).toBe("index.ts");
    expect(srcChildren[1].kind).toBe("file");

    // utils children: helper.ts (file).
    const utilsChildren = childrenOf(root, "src/utils");
    expect(utilsChildren).toHaveLength(1);
    expect(utilsChildren[0].name).toBe("helper.ts");
    expect(utilsChildren[0].kind).toBe("file");
    expect(utilsChildren[0].depth).toBe(3);
  });

  it("deduplicate paths", () => {
    const root = buildPathTree(["a.ts", "a.ts", "/a.ts"]);
    expect(root.children).toHaveLength(1);
  });

  it("정렬: 폴더 우선, case-insensitive", () => {
    const root = buildPathTree(["Zoo.ts", "apple/x.ts", "Mango.ts", "Banana/y.ts", "alpha/z.ts"]);

    // Top level should have dirs (alpha, apple, Banana) before files (Mango.ts, Zoo.ts).
    const children = root.children!;
    const dirs = children.filter((c) => c.kind === "dir").map((c) => c.name);
    const files = children.filter((c) => c.kind === "file").map((c) => c.name);

    // Dirs come before files.
    const lastDirIdx = children.map((c) => c.kind).lastIndexOf("dir");
    const firstFileIdx = children.map((c) => c.kind).indexOf("file");
    expect(lastDirIdx).toBeLessThan(firstFileIdx);

    // Dirs are case-insensitively sorted: alpha, apple, Banana.
    expect(dirs).toEqual(["alpha", "apple", "Banana"]);
    // Files are case-insensitively sorted: Mango.ts, Zoo.ts.
    expect(files).toEqual(["Mango.ts", "Zoo.ts"]);
  });
});

// ---------------------------------------------------------------------------
// collectDescendantLeafPaths
// ---------------------------------------------------------------------------

describe("collectDescendantLeafPaths", () => {
  it("file node → single element with its relPath", () => {
    const root = buildPathTree(["a.ts"]);
    const fileNode = root.children![0];
    expect(fileNode.kind).toBe("file");
    expect(collectDescendantLeafPaths(fileNode)).toEqual(["a.ts"]);
  });

  it("dir node → all descendant leaf relPaths flat", () => {
    const root = buildPathTree(["src/utils/helper.ts", "src/index.ts", "README.md"]);
    // src dir has index.ts and utils/helper.ts as descendants.
    const srcNode = root.children!.find((c) => c.relPath === "src")!;
    expect(srcNode.kind).toBe("dir");
    const paths = collectDescendantLeafPaths(srcNode);
    expect(paths.sort()).toEqual(["src/index.ts", "src/utils/helper.ts"]);
  });

  it("root node → all file relPaths across entire tree", () => {
    const root = buildPathTree(["src/utils/helper.ts", "src/index.ts", "README.md"]);
    const paths = collectDescendantLeafPaths(root);
    expect(paths.sort()).toEqual(["README.md", "src/index.ts", "src/utils/helper.ts"]);
  });

  it("dir with no children → empty array", () => {
    // Manually construct a dir node with no children.
    const emptyDir: PathTreeNode = {
      name: "empty",
      relPath: "empty",
      kind: "dir",
      depth: 1,
      displayName: "empty",
      children: [],
    };
    expect(collectDescendantLeafPaths(emptyDir)).toEqual([]);
  });
});
