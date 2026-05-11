/**
 * Scenario coverage for History-specific GitRepository operations.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitLogArgs } from "../../../../src/main/git/git-repository";
import {
  buildLogArgs,
  GitRepository,
  parseLogRecord,
} from "../../../../src/main/git/git-repository";
import { ipcContract } from "../../../../src/shared/ipc-contract";
import { type LogEntry, LogEntrySchema } from "../../../../src/shared/types/git";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository history", () => {
  realGitTest("paginates by last-SHA seed so inserted commits do not shift page 2", async () => {
    const root = makeRepo("nexus-history-page-");
    try {
      for (let i = 1; i <= 55; i += 1) {
        writeAndCommit(root, "file.txt", `value ${i}\n`, `commit ${i}`);
      }
      const repo = new GitRepository("ws-history-page", root, path.join(root, ".git"), gitOnPath!);

      const firstPage = await collectLog(repo, { ref: "HEAD", limit: 50 });
      expect(firstPage.entries).toHaveLength(50);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.entries[0]?.subject).toBe("commit 55");
      expect(firstPage.entries.at(-1)?.subject).toBe("commit 6");

      const lastSha = firstPage.entries.at(-1)?.sha;
      if (!lastSha) throw new Error("expected page seed");
      writeAndCommit(root, "inserted.txt", "new tip\n", "commit 56");

      const secondPage = await collectLog(repo, { afterSha: lastSha, limit: 50 });
      expect(secondPage.entries.map((entry) => entry.subject)).toEqual([
        "commit 5",
        "commit 4",
        "commit 3",
        "commit 2",
        "commit 1",
      ]);
      expect(secondPage.entries.some((entry) => entry.subject === "commit 6")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("paginates all branches by seeking past the cursor without repeats", async () => {
    const root = makeRepo("nexus-history-all-page-");
    try {
      for (let i = 1; i <= 55; i += 1) {
        writeAndCommit(root, "file.txt", `value ${i}\n`, `commit ${i}`);
      }
      const repo = new GitRepository(
        "ws-history-all-page",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );

      const firstPage = await collectLog(repo, { scope: "all", limit: 50 });
      expect(firstPage.entries).toHaveLength(50);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.entries[0]?.subject).toBe("commit 55");
      expect(firstPage.entries.at(-1)?.subject).toBe("commit 6");

      const lastSha = firstPage.entries.at(-1)?.sha;
      if (!lastSha) throw new Error("expected all-branches page seed");

      const secondPage = await collectLog(repo, { scope: "all", afterSha: lastSha, limit: 50 });
      expect(secondPage.entries.map((entry) => entry.subject)).toEqual([
        "commit 5",
        "commit 4",
        "commit 3",
        "commit 2",
        "commit 1",
      ]);
      expect(secondPage.hasMore).toBe(false);

      const firstPageSubjects = new Set(firstPage.entries.map((entry) => entry.subject));
      expect(secondPage.entries.some((entry) => firstPageSubjects.has(entry.subject))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("search resolves SHA prefixes and greps commit messages", async () => {
    const root = makeRepo("nexus-history-search-");
    try {
      writeAndCommit(root, "a.txt", "a\n", "initial");
      const fixSha = writeAndCommit(root, "popover.txt", "fix\n", "fix popover");
      writeAndCommit(root, "other.txt", "other\n", "other work");
      const repo = new GitRepository(
        "ws-history-search",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );

      const shaResult = await repo.searchCommits(fixSha.slice(0, 7), 50);
      expect(shaResult.kind).toBe("sha");
      if (shaResult.kind !== "sha") throw new Error("expected SHA search result");
      expect(shaResult.detail.sha).toBe(fixSha);
      expect(shaResult.detail.subject).toBe("fix popover");
      expect(shaResult.detail.files).toEqual([{ status: "A", path: "popover.txt" }]);

      const grepResult = await repo.searchCommits("fix popover", 50);
      expect(grepResult.kind).toBe("grep");
      if (grepResult.kind !== "grep") throw new Error("expected grep search result");
      expect(grepResult.entries.map((entry) => entry.sha)).toEqual([fixSha]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("merge commit detail reports parents and omits files", async () => {
    const root = makeRepo("nexus-history-merge-detail-");
    try {
      writeAndCommit(root, "base.txt", "base\n", "base");
      runGit(root, ["checkout", "-b", "feature"]);
      writeAndCommit(root, "feature.txt", "feature\n", "feature");
      runGit(root, ["checkout", "main"]);
      writeAndCommit(root, "main.txt", "main\n", "main");
      runGit(root, ["merge", "--no-ff", "feature", "-m", "Merge feature"]);
      const mergeSha = runGit(root, ["rev-parse", "HEAD"]).trim();
      const repo = new GitRepository("ws-history-merge", root, path.join(root, ".git"), gitOnPath!);

      const detail = await repo.commitDetail(mergeSha);
      expect(detail.parents).toHaveLength(2);
      expect(detail.files).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("git log schema and argv", () => {
  test("defaults legacy LogEntry payload refs to an empty array", () => {
    const entry = LogEntrySchema.parse({
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parents: [],
      authorName: "Ada",
      authoredAt: "2026-05-10T00:00:00.000Z",
      subject: "legacy payload",
    });

    expect(entry.refs).toEqual([]);
  });

  test("validates structured LogEntry refs", () => {
    const entry = LogEntrySchema.parse({
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parents: [],
      authorName: "Ada",
      authoredAt: "2026-05-10T00:00:00.000Z",
      subject: "tagged payload",
      refs: [{ name: "v1", kind: "tag", isHead: false }],
    });

    expect(entry.refs).toEqual([{ name: "v1", kind: "tag", isHead: false }]);
    expect(() =>
      LogEntrySchema.parse({
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        parents: [],
        authorName: "Ada",
        authoredAt: "2026-05-10T00:00:00.000Z",
        subject: "bad ref",
        refs: [{ name: "v1", kind: "release", isHead: false }],
      }),
    ).toThrow();
  });

  test("accepts git log IPC scope enum while preserving omitted-scope callers", () => {
    const baseArgs = { workspaceId: "22222222-2222-4222-8222-222222222222", limit: 20 };

    expect(ipcContract.git.stream.log.args.safeParse(baseArgs).success).toBe(true);
    expect(ipcContract.git.stream.log.args.safeParse({ ...baseArgs, scope: "ref" }).success).toBe(
      true,
    );
    expect(ipcContract.git.stream.log.args.safeParse({ ...baseArgs, scope: "all" }).success).toBe(
      true,
    );
    expect(
      ipcContract.git.stream.log.args.safeParse({ ...baseArgs, scope: "branches" }).success,
    ).toBe(true);
    expect(ipcContract.git.stream.log.args.safeParse({ ...baseArgs, scope: "tags" }).success).toBe(
      false,
    );
  });

  test.each([
    ["default ref scope", {}, ["log", prettyLogFormatArg(), "--date=iso-strict"]],
    [
      "explicit ref scope with named ref",
      { scope: "ref", ref: "main", limit: 2 },
      ["log", prettyLogFormatArg(), "--date=iso-strict", "--max-count=3", "main"],
    ],
    [
      "ref scope with grep, skip, and limit",
      { scope: "ref", ref: "main", grep: " fix ", skip: 10, limit: 50 },
      [
        "log",
        prettyLogFormatArg(),
        "--date=iso-strict",
        "--grep=fix",
        "--skip=10",
        "--max-count=51",
        "main",
      ],
    ],
    [
      "ref scope afterSha cursor overrides named ref",
      { scope: "ref", ref: "main", afterSha: " abc123 ", limit: 5 },
      ["log", prettyLogFormatArg(), "--date=iso-strict", "--max-count=6", "abc123^@"],
    ],
    [
      "all scope uses source-aware all-ref traversal",
      { scope: "all", limit: 20 },
      [
        "log",
        prettyLogFormatArg({ hasSource: true }),
        "--date=iso-strict",
        "--max-count=21",
        "--source",
        "--all",
      ],
    ],
    [
      "all scope cursor omits revision and max-count so streamLog can seek",
      { scope: "all", afterSha: " abc123 ", limit: 20 },
      ["log", prettyLogFormatArg({ hasSource: true }), "--date=iso-strict", "--source", "--all"],
    ],
    [
      "branches scope uses source-aware branch traversal",
      { scope: "branches", ref: "main", limit: 20 },
      [
        "log",
        prettyLogFormatArg({ hasSource: true }),
        "--date=iso-strict",
        "--max-count=21",
        "--source",
        "--branches",
      ],
    ],
  ] satisfies Array<
    readonly [string, GitLogArgs, string[]]
  >)("builds %s argv", (_label, args, expected) => {
    expect(buildLogArgs(args)).toEqual(expected);
  });

  test("rejects skip pagination outside ref scope", () => {
    expect(() => buildLogArgs({ scope: "all", skip: 0 })).toThrow(
      "`skip` is only supported for ref-scoped git logs.",
    );
    expect(() => buildLogArgs({ scope: "branches", skip: 1 })).toThrow(
      "`skip` is only supported for ref-scoped git logs.",
    );
  });
});

describe("git log decoration parsing", () => {
  test.each([
    ["empty", "", []],
    ["HEAD-only", "HEAD", [{ name: "HEAD", kind: "head", isHead: true }]],
    [
      "branch+remote",
      "main, origin/main",
      [
        { name: "main", kind: "branch", isHead: false },
        { name: "origin/main", kind: "remote", isHead: false },
      ],
    ],
    ["tag", "tag: v1", [{ name: "v1", kind: "tag", isHead: false }]],
    [
      "multi-tag",
      "tag: v1, tag: v2",
      [
        { name: "v1", kind: "tag", isHead: false },
        { name: "v2", kind: "tag", isHead: false },
      ],
    ],
    [
      "mixed",
      "HEAD -> main, origin/main, tag: v1",
      [
        { name: "HEAD", kind: "head", isHead: true },
        { name: "main", kind: "branch", isHead: true },
        { name: "origin/main", kind: "remote", isHead: false },
        { name: "v1", kind: "tag", isHead: false },
      ],
    ],
  ])("parses %s decorations", (_label, decorations, refs) => {
    expect(parseLogRecord(logRecord(decorations))?.refs).toEqual(refs);
  });

  test("parses source-aware records without treating %S as a ref", () => {
    expect(parseLogRecord(logRecord("tag: v1", { source: "main" }), { hasSource: true })).toEqual(
      expect.objectContaining({
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        refs: [{ name: "v1", kind: "tag", isHead: false }],
      }),
    );
  });
});

/** Collects a log stream while preserving the generator return value. */
async function collectLog(
  repo: GitRepository,
  args: GitLogArgs,
): Promise<{ entries: LogEntry[]; hasMore: boolean }> {
  const entries: LogEntry[] = [];
  const stream = repo.log(args);
  for (;;) {
    const next = await stream.next();
    if (next.done) return { entries, hasMore: Boolean(next.value.hasMore) };
    entries.push(...next.value.entries);
  }
}

/** Creates an initialized repository with deterministic user config. */
function makeRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  return root;
}

/** Writes one file and returns the new commit SHA. */
function writeAndCommit(root: string, relPath: string, content: string, message: string): string {
  fs.writeFileSync(path.join(root, relPath), content, "utf8");
  runGit(root, ["add", relPath]);
  runGit(root, ["commit", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]).trim();
}

/** Runs git in a fixture repository and returns stdout. */
function runGit(cwd: string, args: string[]): string {
  return execFileSync(gitOnPath ?? "git", args, { cwd, encoding: "utf8" });
}

/** Returns the git binary path when available on the test host. */
function findGitOnPath(): string | null {
  try {
    return execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Builds one formatted log record matching the repository parser format. */
function logRecord(decorations: string, options: { source?: string } = {}): string {
  const fields = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "aaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "Ada",
    "ada@example.invalid",
    "2026-05-10T00:00:00.000Z",
    "subject",
    "body",
    decorations,
  ];
  if (options.source) fields.unshift(options.source);
  return fields.join("\x1f");
}

/** Builds the exact `--pretty` argv expected by History log scenarios. */
function prettyLogFormatArg(options: { hasSource?: boolean } = {}): string {
  const fields = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%s", "%b", "%D"];
  if (options.hasSource) fields.unshift("%S");
  return `--pretty=format:${fields.join("%x1f")}%x1e`;
}
