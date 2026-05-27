/**
 * Pure tests for the file-tree git decoration helpers.
 *
 * Covers the contract that the file tree depends on:
 *   - porcelain v2 xy codes map to the expected DecorationKind
 *   - propagation only walks ancestors for kinds that should bubble up
 *   - priority resolves the right winner when two kinds reach one path
 */
import { describe, expect, it } from "bun:test";
import {
  type GitDecorationKind,
  kindFromEntry,
  maxKind,
  priority,
  propagatesToParents,
  propagateToAncestors,
} from "../../../../../../src/renderer/components/files/file-tree/git-decoration";
import type { GitStatusEntry } from "../../../../../../src/shared/git/types";

function entry(xy: string, relPath = "a/b/c.ts"): GitStatusEntry {
  return { xy, relPath, conflictType: null };
}

describe("kindFromEntry — porcelain v2 xy → kind", () => {
  it("classifies untracked and ignored markers", () => {
    expect(kindFromEntry(entry("??"))).toBe("untracked");
    expect(kindFromEntry(entry("!!"))).toBe("ignored");
  });

  it("classifies single-side modifications by the working tree letter first", () => {
    expect(kindFromEntry(entry(" M"))).toBe("modified");
    expect(kindFromEntry(entry("M "))).toBe("modified");
    expect(kindFromEntry(entry("MM"))).toBe("modified");
  });

  it("classifies additions", () => {
    expect(kindFromEntry(entry("A "))).toBe("added");
    expect(kindFromEntry(entry("AM"))).toBe("modified"); // working tree side wins
  });

  it("classifies deletions", () => {
    expect(kindFromEntry(entry("D "))).toBe("deleted");
    expect(kindFromEntry(entry(" D"))).toBe("deleted");
  });

  it("classifies renames and copies as renamed", () => {
    expect(kindFromEntry(entry("R "))).toBe("renamed");
    expect(kindFromEntry(entry("C "))).toBe("renamed");
  });

  it("classifies type-change as modified (symlink/exec-bit flips)", () => {
    expect(kindFromEntry(entry("T "))).toBe("modified");
    expect(kindFromEntry(entry(" T"))).toBe("modified");
  });

  it("uses the entry.conflictType field as the conflict signal", () => {
    const c: GitStatusEntry = { xy: "UU", relPath: "x", conflictType: "both-modified" };
    expect(kindFromEntry(c)).toBe("conflict");
  });

  it("falls back to null when xy is two spaces", () => {
    expect(kindFromEntry(entry("  "))).toBeNull();
  });
});

describe("priority", () => {
  it("conflicts outrank modifications outrank renames outrank ignored", () => {
    const ranked: GitDecorationKind[] = [
      "conflict",
      "deleted",
      "modified",
      "added",
      "untracked",
      "renamed",
      "ignored",
    ];
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(priority(ranked[i]!)).toBeGreaterThanOrEqual(priority(ranked[i + 1]!));
    }
    // Strict ordering at the boundaries that actually matter:
    expect(priority("conflict")).toBeGreaterThan(priority("modified"));
    expect(priority("modified")).toBeGreaterThan(priority("renamed"));
    expect(priority("renamed")).toBeGreaterThan(priority("ignored"));
  });
});

describe("maxKind", () => {
  it("returns the higher-priority kind", () => {
    expect(maxKind("modified", "renamed")).toBe("modified");
    expect(maxKind("renamed", "modified")).toBe("modified");
    expect(maxKind("conflict", "deleted")).toBe("conflict");
  });
});

describe("propagatesToParents", () => {
  it("modifies, adds, untracked, renames, conflicts bubble up", () => {
    expect(propagatesToParents("modified")).toBe(true);
    expect(propagatesToParents("added")).toBe(true);
    expect(propagatesToParents("untracked")).toBe(true);
    expect(propagatesToParents("renamed")).toBe(true);
    expect(propagatesToParents("conflict")).toBe(true);
  });

  it("deleted and ignored do not bubble up", () => {
    expect(propagatesToParents("deleted")).toBe(false);
    expect(propagatesToParents("ignored")).toBe(false);
  });
});

describe("propagateToAncestors", () => {
  it("marks every directory between root and the file's parent (root excluded)", () => {
    const folders = new Map<string, GitDecorationKind>();
    propagateToAncestors(folders, "/ws/src/a/b/c.ts", "modified", "/ws");
    expect(folders.get("/ws/src")).toBe("modified");
    expect(folders.get("/ws/src/a")).toBe("modified");
    expect(folders.get("/ws/src/a/b")).toBe("modified");
    // Root is excluded — decorating the workspace root is noise.
    expect(folders.has("/ws")).toBe(false);
  });

  it("does not propagate deleted (file removal should not redden the folder)", () => {
    const folders = new Map<string, GitDecorationKind>();
    propagateToAncestors(folders, "/ws/a/b.ts", "deleted", "/ws");
    expect(folders.size).toBe(0);
  });

  it("does not propagate ignored", () => {
    const folders = new Map<string, GitDecorationKind>();
    propagateToAncestors(folders, "/ws/node_modules/lib/index.js", "ignored", "/ws");
    expect(folders.size).toBe(0);
  });

  it("resolves to the higher-priority kind when two files propagate the same folder", () => {
    const folders = new Map<string, GitDecorationKind>();
    propagateToAncestors(folders, "/ws/dir/a.ts", "renamed", "/ws");
    propagateToAncestors(folders, "/ws/dir/b.ts", "modified", "/ws");
    expect(folders.get("/ws/dir")).toBe("modified");

    // And the other order produces the same result.
    const folders2 = new Map<string, GitDecorationKind>();
    propagateToAncestors(folders2, "/ws/dir/a.ts", "modified", "/ws");
    propagateToAncestors(folders2, "/ws/dir/b.ts", "renamed", "/ws");
    expect(folders2.get("/ws/dir")).toBe("modified");
  });

  it("stops at the root even when the absPath sits deeper", () => {
    const folders = new Map<string, GitDecorationKind>();
    propagateToAncestors(folders, "/ws/x/y/z.ts", "modified", "/ws");
    // Walks only x and x/y; never crosses out of /ws.
    expect(folders.has("/")).toBe(false);
    expect(folders.has("")).toBe(false);
  });
});
