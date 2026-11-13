/** A workspace's repository as another device reads it: its changes, a changed file's diff, its commits. */
import { describe, expect, test } from "bun:test";
import {
  addedHunk,
  filesOf,
  gitDiff,
  gitLog,
  gitStatus,
  hunksOf,
  type RemoteGit,
  type RemoteRepository,
} from "../../../../../src/main/features/remote/git";
import type { DiffSpec, GitStatus, LogEntry } from "../../../../../src/shared/git/types";

function status(over: Partial<GitStatus> = {}): GitStatus {
  return {
    merge: [{ relPath: "c.ts", xy: "UU" }],
    staged: [
      { relPath: "a.ts", xy: "M " },
      { relPath: "new-name.ts", oldRelPath: "old-name.ts", xy: "R " },
    ],
    working: [
      { relPath: "a.ts", xy: " M" },
      { relPath: "b.ts", xy: " D" },
    ],
    untracked: [{ relPath: "notes.txt", xy: "??" }],
    branch: { current: "feat", upstream: "origin/feat", ahead: 2, behind: 0, isUnborn: false },
    ...over,
  } as unknown as GitStatus;
}

const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,3 @@ function a()",
  " one",
  "-two",
  "+TWO",
  "\\ No newline at end of file",
  "@@ -10 +10,2 @@",
  " ten",
  "+eleven",
  "",
].join("\n");

const entry = (i: number): LogEntry => ({
  sha: `sha${i}`,
  parents: [],
  authorName: "Me",
  authoredAt: "2026-11-14T00:00:00Z",
  subject: `commit ${i}`,
  refs: i === 0 ? [{ name: "feat", kind: "branch", isHead: true }] : [],
});

function repo(diffs: Partial<Record<DiffSpec["kind"], string>> = {}): {
  git: RemoteGit;
  specs: DiffSpec[];
} {
  const specs: DiffSpec[] = [];
  const repository = {
    topLevel: "/src/app",
    status: async () => status(),
    diff: async function* (spec: DiffSpec) {
      specs.push(spec);
      yield { text: diffs[spec.kind] ?? "" };
      return { bytes: 0, truncated: false };
    },
    log: async function* ({ limit = 50, skip = 0 }: { limit?: number; skip?: number }) {
      const all = Array.from({ length: 120 }, (_, i) => entry(i)).slice(skip);
      for (let i = 0; i < all.length; i += 50) yield { entries: all.slice(i, i + 50) };
      return { count: Math.min(limit, all.length) };
    },
  } as unknown as RemoteRepository;
  return {
    git: {
      repository: async (id) => (id === "w1" ? repository : null),
      readUntracked: async (_w, absolute) => (absolute === "/src/app/notes.txt" ? "a\nb\n" : ""),
    },
    specs,
  };
}

describe("a repository's changes", () => {
  test("each file once, with what is staged of it and what is not", () => {
    expect(filesOf(status())).toEqual([
      { path: "c.ts", staged: "U", unstaged: "U" },
      { path: "a.ts", staged: "M", unstaged: "M" },
      { path: "new-name.ts", oldPath: "old-name.ts", staged: "R" },
      { path: "b.ts", unstaged: "D" },
      { path: "notes.txt", unstaged: "?" },
    ]);
  });

  test("with its branch against its upstream; NotFound for no repository", async () => {
    const { git } = repo();
    expect(await gitStatus(git, { workspaceId: "w1" })).toMatchObject({
      branch: "feat",
      upstream: "origin/feat",
      ahead: 2,
      behind: 0,
    });
    await expect(gitStatus(git, { workspaceId: "w2" })).rejects.toMatchObject({ code: 1001 });
  });
});

describe("a changed file's diff", () => {
  test("its hunks, as jsdiff gives them", () => {
    expect(hunksOf(DIFF)).toEqual({
      binary: false,
      hunks: [
        { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" one", "-two", "+TWO"] },
        { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [" ten", "+eleven"] },
      ],
    });
    expect(hunksOf("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toEqual({
      binary: true,
      hunks: [],
    });
    expect(addedHunk("a\nb\n")).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] },
    ]);
  });

  test("unstaged against the index, staged against HEAD, a new file all added", async () => {
    const { git, specs } = repo({ "wt-vs-index": DIFF, "index-vs-head": DIFF });
    expect((await gitDiff(git, { workspaceId: "w1", path: "a.ts" })).hunks).toHaveLength(2);
    await gitDiff(git, { workspaceId: "w1", path: "new-name.ts", staged: true });
    expect(specs).toEqual([
      { kind: "wt-vs-index", relPath: "a.ts" },
      { kind: "index-vs-head", relPath: "new-name.ts", oldRelPath: "old-name.ts" },
    ]);
    expect(await gitDiff(git, { workspaceId: "w1", path: "notes.txt" })).toEqual({
      path: "notes.txt",
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] }],
    });
  });

  test("only of a change git sees", async () => {
    const { git } = repo();
    await expect(gitDiff(git, { workspaceId: "w1", path: "/etc/passwd" })).rejects.toMatchObject({
      code: 1001,
    });
    await expect(
      gitDiff(git, { workspaceId: "w1", path: "b.ts", staged: true }),
    ).rejects.toMatchObject({ code: 1001 });
  });
});

describe("a repository's commits", () => {
  test("so many from so far back, with their refs", async () => {
    const { git } = repo();
    const { commits } = await gitLog(git, { workspaceId: "w1", limit: 60 });
    expect(commits).toHaveLength(60);
    expect(commits[0]).toEqual({
      hash: "sha0",
      subject: "commit 0",
      author: "Me",
      at: Date.parse("2026-11-14T00:00:00Z"),
      refs: ["feat"],
    });
    const later = await gitLog(git, { workspaceId: "w1", limit: 5, skip: 100 });
    expect(later.commits.map((c) => c.hash)).toEqual([
      "sha100",
      "sha101",
      "sha102",
      "sha103",
      "sha104",
    ]);
  });
});
