/** A workspace's repository as another device reads it: its changes, a changed file's diff, its commits, what one changed. */
import { describe, expect, test } from "bun:test";
import {
  addedHunk,
  filesOf,
  gitDiff,
  gitLog,
  gitShow,
  gitStatus,
  hunksOf,
  type RemoteGit,
  type RemoteRepository,
} from "../../../../../src/main/features/remote/git";
import type {
  CommitDetail,
  DiffSpec,
  GitStatus,
  LogEntry,
} from "../../../../../src/shared/git/types";

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

const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ROOT = "0000000000000000000000000000000000000abc";

const commits: Record<string, CommitDetail> = {
  [HASH]: {
    sha: HASH,
    parents: ["ffff000000000000000000000000000000000001"],
    subject: "Fix the thing",
    author: "Me",
    authorEmail: "me@example.com",
    // Committed later than written: a rebase.
    committerTs: "2026-11-14T09:00:00+09:00",
    message: "Fix the thing\n\nIt was broken.",
    body: "It was broken.",
    files: [
      { status: "M", path: "a.ts" },
      { status: "R087", oldPath: "old-name.ts", path: "new-name.ts" },
    ],
  },
  [ROOT]: {
    sha: ROOT,
    parents: [],
    subject: "First",
    author: "Me",
    authorEmail: "me@example.com",
    committerTs: "2026-01-01T00:00:00Z",
    message: "First",
    body: "",
    files: [{ status: "A", path: "README.md" }],
  },
};

function repo(
  diffs: Partial<Record<DiffSpec["kind"], string>> = {},
  detail: (sha: string) => CommitDetail | undefined = (sha) =>
    Object.values(commits).find((c) => c.sha.startsWith(sha)),
): {
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
    log: async function* ({
      limit = 50,
      skip = 0,
      ref,
    }: {
      limit?: number;
      skip?: number;
      ref?: string;
    }) {
      if (ref) {
        yield { entries: [{ ...entry(0), sha: ref, authoredAt: "2026-11-10T00:00:00Z" }] };
        return { count: 1 };
      }
      const all = Array.from({ length: 120 }, (_, i) => entry(i)).slice(skip);
      for (let i = 0; i < all.length; i += 50) yield { entries: all.slice(i, i + 50) };
      return { count: Math.min(limit, all.length) };
    },
    commitDetail: async (sha: string) => {
      const found = detail(sha);
      if (!found) throw new Error(`fatal: bad object ${sha}`);
      return found;
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

describe("a commit", () => {
  test("who made it and when it was written, its message and the files it changed", async () => {
    const { git } = repo();
    expect(await gitShow(git, { workspaceId: "w1", hash: HASH.slice(0, 7) })).toEqual({
      hash: HASH,
      parents: ["ffff000000000000000000000000000000000001"],
      subject: "Fix the thing",
      body: "It was broken.",
      author: "Me",
      // As git.log has it: written, not committed.
      at: Date.parse("2026-11-10T00:00:00Z"),
      files: [
        { path: "a.ts", status: "M" },
        { path: "new-name.ts", oldPath: "old-name.ts", status: "R" },
      ],
    });
    const root = await gitShow(git, { workspaceId: "w1", hash: ROOT });
    expect(root.parents).toEqual([]);
    expect(root).not.toHaveProperty("body");
  });

  test("NotFound for one the repository does not have, or no repository", async () => {
    const { git } = repo();
    await expect(gitShow(git, { workspaceId: "w1", hash: "deadbeef" })).rejects.toMatchObject({
      code: 1001,
    });
    await expect(gitShow(git, { workspaceId: "w2", hash: HASH })).rejects.toMatchObject({
      code: 1001,
    });
  });

  test("thousands of files: as many as go in a frame", async () => {
    const many: CommitDetail = {
      ...(commits[HASH] as CommitDetail),
      files: Array.from({ length: 20_000 }, (_, i) => ({
        status: "A",
        path: `generated/${"x".repeat(60)}/${i}.ts`,
      })),
    };
    const { git } = repo({}, () => many);
    const shown = await gitShow(git, { workspaceId: "w1", hash: HASH });
    expect(shown.truncated).toBe(true);
    expect(shown.files.length).toBeGreaterThan(1000);
    expect(shown.files.length).toBeLessThan(20_000);
  });

  test("a file's change in it, against its first parent or, for a root commit, nothing", async () => {
    const { git, specs } = repo({ "ref-vs-ref": DIFF });
    const diff = await gitDiff(git, { workspaceId: "w1", path: "new-name.ts", commit: HASH });
    expect(diff).toMatchObject({ path: "new-name.ts", oldPath: "old-name.ts" });
    expect(diff.hunks).toHaveLength(2);
    await gitDiff(git, { workspaceId: "w1", path: "README.md", commit: ROOT });
    expect(specs).toEqual([
      {
        kind: "ref-vs-ref",
        leftRef: "ffff000000000000000000000000000000000001",
        rightRef: HASH,
        relPath: "new-name.ts",
        oldRelPath: "old-name.ts",
      },
      {
        kind: "ref-vs-ref",
        leftRef: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        rightRef: ROOT,
        relPath: "README.md",
      },
    ]);
  });

  test("only of a file it changed, and not staged", async () => {
    const { git, specs } = repo({ "ref-vs-ref": DIFF });
    await expect(
      gitDiff(git, { workspaceId: "w1", path: "b.ts", commit: HASH }),
    ).rejects.toMatchObject({ code: 1001 });
    await expect(
      gitDiff(git, { workspaceId: "w1", path: "a.ts", commit: HASH, staged: true }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(specs).toEqual([]);
  });
});
