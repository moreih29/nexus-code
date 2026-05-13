/**
 * Scenario tests for stash list parsing, indexed apply, and path-scoped group
 * stash behavior.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitError } from "../../../../src/main/git/git-error";
import {
  applyStash,
  listStashes,
  parseStashList,
  stashGroup,
} from "../../../../src/main/git/git-stash";
import { localSemanticExecutor } from "./helpers/local-semantic-executor";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("parseStashList", () => {
  test("returns index, sha, cleaned message, branch, and millisecond timestamp", () => {
    const stdout =
      "stash@{0}\x000123456789abcdef0123456789abcdef01234567\x00On main: grouped work\x001700000000\x00\n" +
      "stash@{1}\x00abcdefabcdefabcdefabcdefabcdefabcdefabcd\x00WIP on feature/x: 1234567 base subject\x001699999900\x00\n";

    expect(parseStashList(stdout)).toEqual([
      {
        index: 0,
        sha: "0123456789abcdef0123456789abcdef01234567",
        message: "grouped work",
        branch: "main",
        createdAt: 1_700_000_000_000,
      },
      {
        index: 1,
        sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        message: "1234567 base subject",
        branch: "feature/x",
        createdAt: 1_699_999_900_000,
      },
    ]);
  });
});

describe("git stash helpers", () => {
  realGitTest("listStashes returns parsed entries created by real git", async () => {
    const root = makeRepo();
    try {
      fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n", "utf8");
      await stashGroup(git(root), ["tracked.txt"], "stash list message");

      const entries = await listStashes(git(root));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        index: 0,
        message: "stash list message",
        branch: currentBranch(root),
      });
      expect(entries[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(entries[0]?.createdAt).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("stashGroup stashes only selected tracked and untracked paths", async () => {
    const root = makeRepo();
    try {
      fs.writeFileSync(path.join(root, "tracked.txt"), "selected change\n", "utf8");
      fs.writeFileSync(path.join(root, "other.txt"), "other change\n", "utf8");
      fs.writeFileSync(path.join(root, "selected-untracked.txt"), "selected\n", "utf8");
      fs.writeFileSync(path.join(root, "other-untracked.txt"), "other\n", "utf8");

      await stashGroup(git(root), ["tracked.txt", "selected-untracked.txt"], "group only");

      expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("base\n");
      expect(fs.readFileSync(path.join(root, "other.txt"), "utf8")).toBe("other change\n");
      expect(fs.existsSync(path.join(root, "selected-untracked.txt"))).toBe(false);
      expect(fs.existsSync(path.join(root, "other-untracked.txt"))).toBe(true);
      expect((await listStashes(git(root)))[0]?.message).toBe("group only");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("applyStash maps content merge failures to stash-conflict", async () => {
    const root = makeRepo();
    try {
      fs.writeFileSync(path.join(root, "tracked.txt"), "stashed line\n", "utf8");
      await stashGroup(git(root), ["tracked.txt"], "conflicting stash");
      fs.writeFileSync(path.join(root, "tracked.txt"), "head line\n", "utf8");
      runGit(root, ["add", "tracked.txt"]);
      runGit(root, ["commit", "-m", "conflicting head"]);

      try {
        await applyStash(git(root), 0);
        throw new Error("expected stash apply to conflict");
      } catch (error) {
        expect((error as GitError).kind).toBe("stash-conflict");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Returns the Git command context for a fixture repository. */
function git(root: string) {
  if (!gitOnPath) throw new Error("git missing");
  return {
    bin: gitOnPath,
    cwd: root,
    executor: localSemanticExecutor(gitOnPath, path.join(root, ".git")),
  };
}

/** Creates a committed repository with two tracked files. */
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-stash-"));
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n", "utf8");
  fs.writeFileSync(path.join(root, "other.txt"), "other base\n", "utf8");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "init"]);
  return root;
}

/** Reads the current branch name from a fixture repository. */
function currentBranch(root: string): string {
  return runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

/** Runs real git in the fixture repository. */
function runGit(cwd: string, args: string[]): string {
  if (!gitOnPath) throw new Error("git missing");
  return execFileSync(gitOnPath, args, { cwd, encoding: "utf8" });
}

/** Finds git on PATH for real-git scenario tests. */
function findGitOnPath(): string | null {
  try {
    return execFileSync("which", ["git"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}
