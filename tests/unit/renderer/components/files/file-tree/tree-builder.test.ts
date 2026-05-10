/**
 * Unit tests for tree-builder.ts — buildPathTree and compactPathTree.
 */

import { describe, expect, it } from "bun:test";
import {
  buildPathTree,
  collectDescendantLeafPaths,
  compactPathTree,
  type PathTreeNode,
} from "../../../../../../src/renderer/components/files/file-tree/tree-builder";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect relPaths in DFS order (skipping the root). */
function collectRelPaths(node: PathTreeNode): string[] {
  const out: string[] = [];
  function walk(n: PathTreeNode) {
    if (n.relPath !== "") out.push(n.relPath);
    for (const child of n.children ?? []) walk(child);
  }
  walk(node);
  return out;
}

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
    const root = buildPathTree([
      "Zoo.ts",
      "apple/x.ts",
      "Mango.ts",
      "Banana/y.ts",
      "alpha/z.ts",
    ]);

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
// compactPathTree
// ---------------------------------------------------------------------------

describe("compactPathTree", () => {
  it("compact: 단일 dir 체인 합치기 (a/b/c/file.ts → 'a/b/c' dir + leaf)", () => {
    const root = buildPathTree(["a/b/c/file.ts"]);
    const compacted = compactPathTree(root);

    // Root should have exactly one child representing the collapsed chain.
    expect(compacted.children).toHaveLength(1);
    const chain = compacted.children![0];
    expect(chain.kind).toBe("dir");
    expect(chain.displayName).toBe("a/b/c");

    // The chain node should have one file child.
    expect(chain.children).toHaveLength(1);
    expect(chain.children![0].kind).toBe("file");
    expect(chain.children![0].name).toBe("file.ts");
  });

  it("compact 종료조건 (i) 자식이 file: a/b.ts → 'a' 그대로", () => {
    const root = buildPathTree(["a/b.ts"]);
    const compacted = compactPathTree(root);

    // 'a' has one child but it's a file → not compacted.
    expect(compacted.children).toHaveLength(1);
    const aNode = compacted.children![0];
    expect(aNode.kind).toBe("dir");
    expect(aNode.displayName).toBe("a");

    expect(aNode.children).toHaveLength(1);
    expect(aNode.children![0].kind).toBe("file");
  });

  it("compact 종료조건 (ii) 자식 ≥ 2: a/b.ts, a/c.ts → 'a' 그대로", () => {
    const root = buildPathTree(["a/b.ts", "a/c.ts"]);
    const compacted = compactPathTree(root);

    expect(compacted.children).toHaveLength(1);
    const aNode = compacted.children![0];
    expect(aNode.kind).toBe("dir");
    expect(aNode.displayName).toBe("a");

    // Both files are still children of 'a'.
    expect(aNode.children).toHaveLength(2);
  });

  it("compact 종료조건 (iii) 루트 자체는 압축 금지", () => {
    // Even if root has a single dir child, root itself is not compacted away.
    const root = buildPathTree(["src/index.ts"]);
    const compacted = compactPathTree(root);

    // Root is still the root (relPath === "").
    expect(compacted.relPath).toBe("");
    expect(compacted.kind).toBe("dir");
    expect(compacted.children).toBeDefined();
  });

  it("no-op on already flat tree (only root files)", () => {
    const root = buildPathTree(["a.ts", "b.ts"]);
    const compacted = compactPathTree(root);

    // Files at root level — nothing to compact.
    expect(compacted.children).toHaveLength(2);
    expect(compacted.children!.every((c) => c.kind === "file")).toBe(true);
  });

  it("deep chain preserves file relPaths", () => {
    const root = buildPathTree(["x/y/z/deep.ts"]);
    const compacted = compactPathTree(root);

    const chain = compacted.children![0];
    expect(chain.displayName).toBe("x/y/z");

    // The leaf should retain its full relPath.
    expect(chain.children![0].relPath).toBe("x/y/z/deep.ts");
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
    const root = buildPathTree([
      "src/utils/helper.ts",
      "src/index.ts",
      "README.md",
    ]);
    // src dir has index.ts and utils/helper.ts as descendants.
    const srcNode = root.children!.find((c) => c.relPath === "src")!;
    expect(srcNode.kind).toBe("dir");
    const paths = collectDescendantLeafPaths(srcNode);
    expect(paths.sort()).toEqual(["src/index.ts", "src/utils/helper.ts"]);
  });

  it("root node → all file relPaths across entire tree", () => {
    const root = buildPathTree([
      "src/utils/helper.ts",
      "src/index.ts",
      "README.md",
    ]);
    const paths = collectDescendantLeafPaths(root);
    expect(paths.sort()).toEqual(["README.md", "src/index.ts", "src/utils/helper.ts"]);
  });

  it("compact 후에도 children 유지되어 leaf walk 정상", () => {
    const root = buildPathTree(["a/b/c/file1.ts", "a/b/c/file2.ts"]);
    const compacted = compactPathTree(root);
    // After compaction, root has one child: 'a/b/c' dir with two file children.
    const chainNode = compacted.children![0];
    expect(chainNode.kind).toBe("dir");
    const paths = collectDescendantLeafPaths(chainNode);
    expect(paths.sort()).toEqual(["a/b/c/file1.ts", "a/b/c/file2.ts"]);
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
