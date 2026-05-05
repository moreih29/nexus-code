/**
 * Pure tests for getDisplayFlat — the helper that injects a
 * "pending create" sentinel row at the right depth/position.
 */
import { describe, expect, it } from "bun:test";
import { getDisplayFlat } from "../../../../../src/renderer/components/files/file-tree-display";
import type { FlatItem, TreeNode } from "../../../../../src/renderer/state/stores/files";

function dirNode(name: string): TreeNode {
  return { type: "dir", name, children: [], childrenLoaded: true };
}

function fileNode(name: string): TreeNode {
  return { type: "file", name };
}

function flat(items: Array<[string, TreeNode, number]>): FlatItem[] {
  return items.map(([absPath, node, depth]) => ({ absPath, node, depth }));
}

describe("getDisplayFlat", () => {
  it("returns the original list (wrapped) when there is no pending create", () => {
    const f = flat([
      ["/r", dirNode("r"), 0],
      ["/r/a.ts", fileNode("a.ts"), 1],
    ]);
    const out = getDisplayFlat(f, null);
    expect(out).toHaveLength(2);
    expect(out.every((it) => it.kind === "real")).toBe(true);
  });

  it("inserts a sentinel before the first direct file-child of the parent (VSCode parity)", () => {
    const f = flat([
      ["/r", dirNode("r"), 0],
      ["/r/sub", dirNode("sub"), 1],
      ["/r/sub/a.ts", fileNode("a.ts"), 2],
      ["/r/b.ts", fileNode("b.ts"), 1],
    ]);
    const out = getDisplayFlat(f, { parentAbsPath: "/r/sub", kind: "file" });

    // /r/sub has only file-children, so the sentinel lands right before "a.ts".
    // Expect: r, sub, <pending>, a.ts, b.ts
    expect(out.map((it) => (it.kind === "pending" ? "PENDING" : it.absPath))).toEqual([
      "/r",
      "/r/sub",
      "PENDING",
      "/r/sub/a.ts",
      "/r/b.ts",
    ]);

    const pending = out[2];
    if (pending.kind !== "pending") throw new Error("expected pending");
    expect(pending.depth).toBe(2); // parent depth (1) + 1
    expect(pending.entryKind).toBe("file");
    expect(pending.parentAbsPath).toBe("/r/sub");
  });

  it("places the sentinel between dir-children and file-children of the parent", () => {
    // Parent /r has: dir1 (with a child), dir2, file-a, file-b — sentinel
    // should land *after* dir2 (and dir1's subtree) and *before* file-a.
    const f = flat([
      ["/r", dirNode("r"), 0],
      ["/r/dir1", dirNode("dir1"), 1],
      ["/r/dir1/inner.ts", fileNode("inner.ts"), 2],
      ["/r/dir2", dirNode("dir2"), 1],
      ["/r/file-a.ts", fileNode("file-a.ts"), 1],
      ["/r/file-b.ts", fileNode("file-b.ts"), 1],
    ]);
    const out = getDisplayFlat(f, { parentAbsPath: "/r", kind: "file" });

    expect(out.map((it) => (it.kind === "pending" ? "PENDING" : it.absPath))).toEqual([
      "/r",
      "/r/dir1",
      "/r/dir1/inner.ts",
      "/r/dir2",
      "PENDING",
      "/r/file-a.ts",
      "/r/file-b.ts",
    ]);
  });

  it("places the sentinel at the end of the parent's subtree when it has only dir-children", () => {
    // No file-children under /r/dir1 → sentinel goes after the last dir's
    // subtree but still inside the parent block (before any sibling).
    const f = flat([
      ["/r", dirNode("r"), 0],
      ["/r/dir1", dirNode("dir1"), 1],
      ["/r/dir1/sub", dirNode("sub"), 2],
      ["/r/dir1/sub/x.ts", fileNode("x.ts"), 3],
      ["/r/sibling.ts", fileNode("sibling.ts"), 1],
    ]);
    const out = getDisplayFlat(f, { parentAbsPath: "/r/dir1", kind: "folder" });
    expect(out.map((it) => (it.kind === "pending" ? "PENDING" : it.absPath))).toEqual([
      "/r",
      "/r/dir1",
      "/r/dir1/sub",
      "/r/dir1/sub/x.ts",
      "PENDING",
      "/r/sibling.ts",
    ]);
  });

  it("drops the sentinel when the parent isn't in the visible flat list", () => {
    const f = flat([
      ["/r", dirNode("r"), 0],
      ["/r/a.ts", fileNode("a.ts"), 1],
    ]);
    // Parent /r/hidden isn't in the flat list (collapsed/unloaded).
    const out = getDisplayFlat(f, { parentAbsPath: "/r/hidden", kind: "folder" });
    expect(out).toHaveLength(2);
    expect(out.every((it) => it.kind === "real")).toBe(true);
  });

  it("targets the workspace root as parent (depth 0 → sentinel depth 1)", () => {
    const f = flat([
      ["/r", dirNode("r"), 0],
      ["/r/a.ts", fileNode("a.ts"), 1],
    ]);
    const out = getDisplayFlat(f, { parentAbsPath: "/r", kind: "folder" });
    expect(out).toHaveLength(3);
    expect(out[1].kind).toBe("pending");
    if (out[1].kind === "pending") {
      expect(out[1].depth).toBe(1);
      expect(out[1].entryKind).toBe("folder");
    }
  });
});
