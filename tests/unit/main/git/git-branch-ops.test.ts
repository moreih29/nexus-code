/**
 * Scenario tests for branch management operations.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newLocalGitRepository } from "./helpers/local-semantic-executor";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository branch ops", () => {
  realGitTest(
    "deleteBranch deletes merged branches and force-deletes unmerged branches",
    async () => {
      const root = makeRepoWithCommit();
      try {
        const repo = newLocalGitRepository(
          "ws-delete-branch",
          root,
          path.join(root, ".git"),
          gitOnPath!,
        );
        runGit(root, ["branch", "merged"]);

        await repo.deleteBranch("merged", false);
        expect(runGit(root, ["branch", "--list", "merged"]).trim()).toBe("");

        runGit(root, ["checkout", "-b", "topic"]);
        fs.writeFileSync(path.join(root, "topic.txt"), "topic\n", "utf8");
        runGit(root, ["add", "topic.txt"]);
        runGit(root, ["commit", "-m", "topic"]);
        runGit(root, ["checkout", "main"]);

        await expect(repo.deleteBranch("topic", false)).rejects.toBeInstanceOf(Error);

        await repo.deleteBranch("topic", true);
        expect(runGit(root, ["branch", "--list", "topic"]).trim()).toBe("");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  realGitTest("renameBranch rejects locally invalid names and existing targets", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = newLocalGitRepository(
        "ws-rename-branch",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );
      runGit(root, ["branch", "existing"]);

      await expect(repo.renameBranch("", "new-name")).rejects.toMatchObject({
        kind: "branch-name-invalid",
      });
      await expect(repo.renameBranch("main", "existing")).rejects.toBeInstanceOf(Error);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("setUpstream unsets with null and rejects invalid upstream refs", async () => {
    const { client, remoteUrl } = makeClonePair();
    try {
      const repo = newLocalGitRepository(
        "ws-upstream",
        client,
        path.join(client, ".git"),
        gitOnPath!,
      );

      await repo.setUpstream("main", null);
      expect(() => runGit(client, ["rev-parse", "--abbrev-ref", "main@{upstream}"])).toThrow();

      await expect(repo.setUpstream("main", "origin/definitely-missing")).rejects.toBeInstanceOf(
        Error,
      );
    } finally {
      cleanup(client, remoteUrl);
    }
  });

  realGitTest("fastForwardBranch reports advanced and no-op states", async () => {
    const { client, remoteUrl } = makeClonePair();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-branch-ops-other-"));
    try {
      const repo = newLocalGitRepository(
        "ws-fast-forward",
        client,
        path.join(client, ".git"),
        gitOnPath!,
      );
      runGit(other, ["clone", remoteUrl, "."]);
      runGit(other, ["config", "user.name", "Nexus Test"]);
      runGit(other, ["config", "user.email", "nexus@example.invalid"]);
      fs.writeFileSync(path.join(other, "remote.txt"), "remote\n", "utf8");
      runGit(other, ["add", "remote.txt"]);
      runGit(other, ["commit", "-m", "remote"]);
      runGit(other, ["push", "origin", "main"]);

      const advanced = await repo.fastForwardBranch("main", "origin", "main");
      expect(advanced.advanced).toBe(true);
      expect(advanced.fromSha).not.toBe(advanced.toSha);
      expect(runGit(client, ["rev-parse", "HEAD"]).trim()).toBe(advanced.toSha);

      const noOp = await repo.fastForwardBranch("main", "origin", "main");
      expect(noOp).toEqual({
        advanced: false,
        fromSha: advanced.toSha,
        toSha: advanced.toSha,
      });
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
      cleanup(client, remoteUrl);
    }
  });

  realGitTest("createBranch creates from a tag ref and checkout=true switches to it", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = newLocalGitRepository(
        "ws-create-from-ref",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );
      const baseSha = runGit(root, ["rev-parse", "HEAD"]).trim();
      runGit(root, ["tag", "v1"]);
      fs.writeFileSync(path.join(root, "next.txt"), "next\n", "utf8");
      runGit(root, ["add", "next.txt"]);
      runGit(root, ["commit", "-m", "next"]);

      await repo.createBranch("from-tag", { fromRef: "v1", checkout: false });
      expect(runGit(root, ["rev-parse", "from-tag"]).trim()).toBe(baseSha);
      expect(runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");

      await repo.createBranch("from-tag-checkout", { fromRef: "v1", checkout: true });
      expect(runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("from-tag-checkout");
      expect(runGit(root, ["rev-parse", "HEAD"]).trim()).toBe(baseSha);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleteRemoteBranch uses terminal-prompt-disabled helper environment", async () => {
    const fixture = makeFakeRepo();
    try {
      const repo = newLocalGitRepository(
        "ws-delete-remote",
        fixture.root,
        fixture.gitDir,
        fixture.gitBin,
      );

      await repo.deleteRemoteBranch("origin", "feature");

      expect(readLog(fixture.root)[0]).toMatch("push origin --delete feature|askpass=|terminal=0");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

/** Creates a repository with a single committed file on main. */
function makeRepoWithCommit(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-branch-ops-"));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  runGit(root, ["add", "README.md"]);
  runGit(root, ["commit", "-m", "base"]);
  return root;
}

/**
 * Builds a bare-remote + clone pair with main pushed and tracking origin/main.
 */
function makeClonePair(): { client: string; remoteUrl: string } {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-branch-ops-remote-"));
  runGit(remote, ["init", "--bare"]);

  const seed = makeRepoWithCommit();
  runGit(seed, ["remote", "add", "origin", remote]);
  runGit(seed, ["push", "-u", "origin", "main"]);
  fs.rmSync(seed, { recursive: true, force: true });

  const client = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-branch-ops-client-"));
  runGit(client, ["clone", remote, "."]);
  runGit(client, ["config", "user.name", "Nexus Test"]);
  runGit(client, ["config", "user.email", "nexus@example.invalid"]);
  return { client, remoteUrl: remote };
}

/** Removes both sides of a clone-pair fixture. */
function cleanup(client: string, remoteUrl: string): void {
  fs.rmSync(client, { recursive: true, force: true });
  fs.rmSync(remoteUrl, { recursive: true, force: true });
}

/** Creates a fake repo with a git-compatible script that logs push env. */
function makeFakeRepo(): { root: string; gitDir: string; gitBin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-delete-remote-"));
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  const gitBin = path.join(root, "fake-git.sh");
  const logPath = path.join(root, "git.log");
  fs.writeFileSync(
    gitBin,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s|askpass=%s|terminal=%s\n' "$*" "${"${"}GIT_ASKPASS:-}" "${"${"}GIT_TERMINAL_PROMPT:-}" >> ${shellQuote(logPath)}
`,
    "utf8",
  );
  fs.chmodSync(gitBin, 0o755);
  return { root, gitDir, gitBin };
}

/** Reads fake git log lines. */
function readLog(root: string): string[] {
  return fs.readFileSync(path.join(root, "git.log"), "utf8").split("\n").filter(Boolean);
}

/** Runs git with prompts disabled for deterministic fixtures. */
function runGit(cwd: string, args: string[]): string {
  return execFileSync(gitOnPath!, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

/** Quotes a shell literal for generated test scripts. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
