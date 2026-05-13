/**
 * Scenario coverage for workflow GitRepository operations.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newLocalGitRepository } from "./helpers/local-semantic-executor";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository workflow operations", () => {
  realGitTest(
    "merge returns clean, conflict, already-in-progress, and completed flows",
    async () => {
      const cleanRoot = makeRepoWithCommit("nexus-git-workflow-merge-clean-");
      try {
        const cleanRepo = newLocalGitRepository(
          "ws-merge-clean",
          cleanRoot,
          path.join(cleanRoot, ".git"),
          gitOnPath!,
        );
        runGit(cleanRoot, ["checkout", "-b", "feature"]);
        writeAndCommit(cleanRoot, "feature.txt", "feature\n", "feature");
        runGit(cleanRoot, ["checkout", "main"]);

        await expect(cleanRepo.merge("feature")).resolves.toEqual({ result: "clean" });
        expect(fs.readFileSync(path.join(cleanRoot, "feature.txt"), "utf8")).toBe("feature\n");
      } finally {
        fs.rmSync(cleanRoot, { recursive: true, force: true });
      }

      const conflictRoot = makeMergeConflictRepo();
      try {
        const conflictRepo = newLocalGitRepository(
          "ws-merge-conflict",
          conflictRoot,
          path.join(conflictRoot, ".git"),
          gitOnPath!,
        );

        await expect(conflictRepo.merge("feature")).resolves.toEqual({
          result: "conflicts",
          conflictCount: 1,
        });
        await expect(conflictRepo.merge("feature")).rejects.toMatchObject({
          kind: "merge-already-in-progress",
        });
        await expect(conflictRepo.continueOp()).rejects.toMatchObject({
          kind: "unresolved-conflicts",
        });
        await expect(conflictRepo.markResolved(["README.md"])).rejects.toMatchObject({
          kind: "path-not-conflicted",
        });

        fs.writeFileSync(path.join(conflictRoot, "conflict.txt"), "resolved\n", "utf8");
        await expect(conflictRepo.markResolved(["conflict.txt"])).resolves.toEqual({
          remainingConflicts: 0,
        });
        await expect(conflictRepo.continueOp()).resolves.toEqual({ result: "completed" });
        await expect(conflictRepo.abortOp()).rejects.toMatchObject({
          kind: "no-operation-in-progress",
        });
      } finally {
        fs.rmSync(conflictRoot, { recursive: true, force: true });
      }
    },
  );

  realGitTest(
    "read operations proceed after a merge conflict result releases the queue",
    async () => {
      const root = makeMergeConflictRepo();
      try {
        const repo = newLocalGitRepository(
          "ws-merge-conflict-queue",
          root,
          path.join(root, ".git"),
          gitOnPath!,
        );

        await expect(repo.merge("feature")).resolves.toEqual({
          result: "conflicts",
          conflictCount: 1,
        });

        const status = await withTimeout(repo.status(), 1_000);
        expect(status.merge).toHaveLength(1);
        await repo.abortOp();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  realGitTest(
    "rebase returns progress for clean, conflict, and already-in-progress flows",
    async () => {
      const cleanRoot = makeRebaseCleanRepo();
      try {
        const cleanRepo = newLocalGitRepository(
          "ws-rebase-clean",
          cleanRoot,
          path.join(cleanRoot, ".git"),
          gitOnPath!,
        );

        await expect(cleanRepo.rebase("main")).resolves.toEqual({
          result: "clean",
          conflictCount: 0,
          doneCount: 1,
          totalCount: 1,
        });
      } finally {
        fs.rmSync(cleanRoot, { recursive: true, force: true });
      }

      const conflictRoot = makeRebaseConflictRepo();
      try {
        const conflictRepo = newLocalGitRepository(
          "ws-rebase-conflict",
          conflictRoot,
          path.join(conflictRoot, ".git"),
          gitOnPath!,
        );

        const result = await conflictRepo.rebase("main");
        expect(result.result).toBe("conflicts");
        if (result.result === "conflicts") {
          expect(result.conflictCount).toBe(1);
          expect(result.totalCount).toBeGreaterThanOrEqual(1);
        }
        await expect(conflictRepo.rebase("main")).rejects.toMatchObject({
          kind: "rebase-already-in-progress",
        });
        await conflictRepo.abortOp();
      } finally {
        fs.rmSync(conflictRoot, { recursive: true, force: true });
      }
    },
  );

  realGitTest(
    "cherry-pick returns clean, conflict, already-in-progress, and rejects empty commits",
    async () => {
      const cleanRoot = makeCherryPickCleanRepo();
      try {
        const sha = runGit(cleanRoot, ["rev-parse", "feature"]).trim();
        const cleanRepo = newLocalGitRepository(
          "ws-cherry-clean",
          cleanRoot,
          path.join(cleanRoot, ".git"),
          gitOnPath!,
        );
        runGit(cleanRoot, ["checkout", "main"]);

        await expect(cleanRepo.cherryPick(sha)).resolves.toEqual({ result: "clean" });
        expect(fs.readFileSync(path.join(cleanRoot, "picked.txt"), "utf8")).toBe("picked\n");
      } finally {
        fs.rmSync(cleanRoot, { recursive: true, force: true });
      }

      const conflictRoot = makeCherryPickConflictRepo();
      try {
        const sha = runGit(conflictRoot, ["rev-parse", "feature"]).trim();
        const conflictRepo = newLocalGitRepository(
          "ws-cherry-conflict",
          conflictRoot,
          path.join(conflictRoot, ".git"),
          gitOnPath!,
        );
        runGit(conflictRoot, ["checkout", "main"]);

        await expect(conflictRepo.cherryPick(sha)).resolves.toEqual({
          result: "conflicts",
          conflictCount: 1,
        });
        await expect(conflictRepo.cherryPick(sha)).rejects.toMatchObject({
          kind: "cherry-pick-already-in-progress",
        });
        await conflictRepo.abortOp();
      } finally {
        fs.rmSync(conflictRoot, { recursive: true, force: true });
      }

      const emptyRoot = makeCherryPickEmptyRepo();
      try {
        const sha = runGit(emptyRoot, ["rev-parse", "feature"]).trim();
        const emptyRepo = newLocalGitRepository(
          "ws-cherry-empty",
          emptyRoot,
          path.join(emptyRoot, ".git"),
          gitOnPath!,
        );
        runGit(emptyRoot, ["checkout", "main"]);

        try {
          await expect(emptyRepo.cherryPick(sha)).rejects.toBeInstanceOf(Error);
        } finally {
          runGit(emptyRoot, ["cherry-pick", "--abort"]);
        }
      } finally {
        fs.rmSync(emptyRoot, { recursive: true, force: true });
      }
    },
  );
});

/** Creates a repository with one base commit on main. */
function makeRepoWithCommit(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  writeAndCommit(root, "README.md", "base\n", "base");
  return root;
}

/** Creates a merge conflict repository checked out on main. */
function makeMergeConflictRepo(): string {
  const root = makeRepoWithCommit("nexus-git-workflow-merge-conflict-");
  runGit(root, ["checkout", "-b", "feature"]);
  writeAndCommit(root, "conflict.txt", "feature\n", "feature conflict");
  runGit(root, ["checkout", "main"]);
  writeAndCommit(root, "conflict.txt", "main\n", "main conflict");
  return root;
}

/** Creates a clean rebase repository checked out on feature. */
function makeRebaseCleanRepo(): string {
  const root = makeRepoWithCommit("nexus-git-workflow-rebase-clean-");
  runGit(root, ["checkout", "-b", "feature"]);
  writeAndCommit(root, "feature.txt", "feature\n", "feature");
  runGit(root, ["checkout", "main"]);
  writeAndCommit(root, "main.txt", "main\n", "main");
  runGit(root, ["checkout", "feature"]);
  return root;
}

/** Creates a conflicting rebase repository checked out on feature. */
function makeRebaseConflictRepo(): string {
  const root = makeRepoWithCommit("nexus-git-workflow-rebase-conflict-");
  runGit(root, ["checkout", "-b", "feature"]);
  writeAndCommit(root, "conflict.txt", "feature\n", "feature conflict");
  runGit(root, ["checkout", "main"]);
  writeAndCommit(root, "conflict.txt", "main\n", "main conflict");
  runGit(root, ["checkout", "feature"]);
  return root;
}

/** Creates a cherry-pick repository with a clean feature commit. */
function makeCherryPickCleanRepo(): string {
  const root = makeRepoWithCommit("nexus-git-workflow-cherry-clean-");
  runGit(root, ["checkout", "-b", "feature"]);
  writeAndCommit(root, "picked.txt", "picked\n", "picked");
  return root;
}

/** Creates a cherry-pick repository with a conflicting feature commit. */
function makeCherryPickConflictRepo(): string {
  const root = makeRepoWithCommit("nexus-git-workflow-cherry-conflict-");
  runGit(root, ["checkout", "-b", "feature"]);
  writeAndCommit(root, "conflict.txt", "feature\n", "feature conflict");
  runGit(root, ["checkout", "main"]);
  writeAndCommit(root, "conflict.txt", "main\n", "main conflict");
  return root;
}

/** Creates a cherry-pick repository where the picked commit is already applied. */
function makeCherryPickEmptyRepo(): string {
  const root = makeRepoWithCommit("nexus-git-workflow-cherry-empty-");
  runGit(root, ["checkout", "-b", "feature"]);
  writeAndCommit(root, "same.txt", "same\n", "feature same");
  runGit(root, ["checkout", "main"]);
  writeAndCommit(root, "same.txt", "same\n", "main same");
  return root;
}

/** Writes one file and commits it. */
function writeAndCommit(root: string, relPath: string, content: string, message: string): void {
  fs.writeFileSync(path.join(root, relPath), content, "utf8");
  runGit(root, ["add", relPath]);
  runGit(root, ["commit", "-m", message]);
}

/** Runs git with prompts disabled for deterministic fixtures. */
function runGit(cwd: string, args: string[]): string {
  return execFileSync(gitOnPath!, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Fails the promise if it does not settle inside the requested window. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Finds a git binary on PATH, or null on constrained systems. */
function findGitOnPath(): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(locator, ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}
