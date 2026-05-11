/**
 * Scenario coverage for History-specific GitRepository operations.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitLogArgs } from "../../../../src/main/git/git-repository";
import { GitRepository } from "../../../../src/main/git/git-repository";
import type { LogEntry } from "../../../../src/shared/types/git";

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
