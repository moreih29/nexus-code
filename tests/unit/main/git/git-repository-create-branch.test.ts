/**
 * Reproducer for the user-reported "creating a new branch makes the
 * previous one disappear from the picker" symptom. The backend layer is
 * exercised directly so we can isolate whether the listBranches snapshot
 * is the source of truth (it is) and confirm that git's `checkout -b`
 * does not delete the ref the user came from.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRepository } from "../../../../src/main/git/git-repository";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository.createBranch — preserves source branch", () => {
  realGitTest("creating feat/x from main keeps main in listBranches.local", async () => {
    const root = makeRepoOnMain();
    try {
      const repo = new GitRepository(
        "ws-create-keeps-main",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );

      await repo.createBranch("feat/x", true);

      const head = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      expect(head).toBe("feat/x");

      const list = await repo.listBranches();
      expect(list.local).toContain("main");
      expect(list.local).toContain("feat/x");
      expect(list.current?.current).toBe("feat/x");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest(
    "creating from an unborn HEAD does NOT preserve the unborn branch (documented edge case)",
    async () => {
      // Unborn HEAD is a symbolic ref to a branch that has no commit, so
      // `git checkout -b feat/x` simply re-points HEAD without ever
      // materializing the original branch in refs/heads/. The picker
      // showing only `feat/x` afterwards is correct git semantics, not a
      // missing-branch bug. This test pins that distinction so future
      // changes do not silently mutate behavior.
      const root = makeUnbornRepo();
      try {
        const repo = new GitRepository(
          "ws-create-unborn",
          root,
          path.join(root, ".git"),
          gitOnPath!,
        );

        await repo.createBranch("feat/x", true);
        // Need at least one commit before listBranches reports anything.
        fs.writeFileSync(path.join(root, "README.md"), "init\n", "utf8");
        runGit(root, ["add", "README.md"]);
        runGit(root, ["commit", "-m", "init"]);

        const list = await repo.listBranches();
        expect(list.local).toEqual(["feat/x"]);
        expect(list.local).not.toContain("main");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  realGitTest(
    "creating dev from unborn main via createBranch succeeds and lists only dev",
    async () => {
      // Reproduces the user's `archives/codex-test` flow: starts on unborn
      // `main`, picker create-row routes to createBranch("dev", true),
      // which `git checkout -b` re-points the unborn ref. The previous
      // bug was that the picker also showed `main` as a clickable local
      // entry (synthesized from `git status -b`), so a default-active
      // Enter checkout fired against a ref that did not exist yet.
      const root = makeUnbornRepo();
      try {
        const repo = new GitRepository(
          "ws-unborn-create-dev",
          root,
          path.join(root, ".git"),
          gitOnPath!,
        );

        // The picker source filters out the unborn current branch, so the
        // only routed action for the user's "Create new branch: 'dev'"
        // click is createBranch — never a checkout against unborn `main`.
        await repo.createBranch("dev", true);
        // First commit lands on dev; main never materialises (correct
        // git semantics for unborn-rename).
        fs.writeFileSync(path.join(root, "README.md"), "init\n", "utf8");
        runGit(root, ["add", "README.md"]);
        runGit(root, ["commit", "-m", "init"]);

        const head = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
        expect(head).toBe("dev");

        const list = await repo.listBranches();
        expect(list.local).toEqual(["dev"]);
        expect(list.local).not.toContain("main");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  realGitTest("createBranch checkout=false leaves HEAD on the source branch", async () => {
    const root = makeRepoOnMain();
    try {
      const repo = new GitRepository(
        "ws-create-no-checkout",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );

      await repo.createBranch("feat/x", false);

      const head = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      expect(head).toBe("main");

      const list = await repo.listBranches();
      expect(list.local).toContain("main");
      expect(list.local).toContain("feat/x");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeRepoOnMain(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-create-branch-"));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  runGit(root, ["add", "README.md"]);
  runGit(root, ["commit", "-m", "base"]);
  return root;
}

function makeUnbornRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-unborn-"));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  return root;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync(gitOnPath!, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function findGitOnPath(): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(locator, ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}
