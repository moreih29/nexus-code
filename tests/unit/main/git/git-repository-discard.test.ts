import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newLocalGitRepository } from "./helpers/local-semantic-executor";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository discard source scoping", () => {
  realGitTest("working discard on an MM file preserves staged content", async () => {
    const root = makeRepo();
    try {
      const repo = newLocalGitRepository(
        "workspace-mm-working",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );
      makeMmFile(root);

      await repo.discard(["f.txt"], { source: "working" });

      expect(readIndexFile(root, "f.txt")).toBe("staged\n");
      expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("staged\n");
      expect(runGit(root, ["status", "--porcelain=v1", "--", "f.txt"])).toBe("M  f.txt\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("staged discard on an MM file preserves unstaged working content", async () => {
    const root = makeRepo();
    try {
      const repo = newLocalGitRepository(
        "workspace-mm-staged",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );
      makeMmFile(root);

      await repo.discard(["f.txt"], { source: "staged" });

      expect(readIndexFile(root, "f.txt")).toBe("base\n");
      expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("working\n");
      expect(runGit(root, ["status", "--porcelain=v1", "--", "f.txt"])).toBe(" M f.txt\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Creates a temp repository with one committed file. */
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-discard-"));
  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  fs.writeFileSync(path.join(root, "f.txt"), "base\n", "utf8");
  runGit(root, ["add", "f.txt"]);
  runGit(root, ["commit", "-m", "base"]);
  return root;
}

/** Creates an MM state: index differs from HEAD and worktree differs from index. */
function makeMmFile(root: string): void {
  fs.writeFileSync(path.join(root, "f.txt"), "staged\n", "utf8");
  runGit(root, ["add", "f.txt"]);
  fs.writeFileSync(path.join(root, "f.txt"), "working\n", "utf8");
  expect(runGit(root, ["status", "--porcelain=v1", "--", "f.txt"])).toBe("MM f.txt\n");
}

/** Reads the version of a file currently stored in the index. */
function readIndexFile(root: string, relPath: string): string {
  return runGit(root, ["show", `:${relPath}`]);
}

/** Runs a real git command inside the test repository. */
function runGit(cwd: string, args: string[]): string {
  return execFileSync(gitOnPath!, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Resolves git from PATH only, so these tests skip cleanly without git. */
function findGitOnPath(): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(locator, ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}
