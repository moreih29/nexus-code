/**
 * Scenario tests for Git remote management.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addRemote } from "../../../../src/main/git/git-remote";
import { GitRepository } from "../../../../src/main/git/git-repository";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository remote management", () => {
  realGitTest("addRemote adds a remote and refreshes RepoCapabilities.remotes", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = new GitRepository("ws-add-remote", root, path.join(root, ".git"), gitOnPath!);

      await repo.addRemote("origin", "https://example.invalid/repo.git");

      expect(runGit(root, ["remote"]).trim()).toBe("origin");
      expect((await repo.status()).capabilities.remotes).toEqual(["origin"]);
      await expect(
        repo.addRemote("origin", "ssh://example.invalid/repo.git"),
      ).rejects.toMatchObject({
        kind: "remote-exists",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("addRemote rejects invalid URL patterns before running git", async () => {
    const calls: readonly string[][] = [];
    await expect(
      addRemote(
        {
          run: async (args) => {
            (calls as string[][]).push([...args]);
            return { stdout: "", stderr: "", code: 0 };
          },
        },
        "origin",
        "ftp://example.invalid/repo.git",
      ),
    ).rejects.toMatchObject({ kind: "remote-url-invalid" });
    expect(calls).toEqual([]);
  });

  realGitTest("removeRemote removes a remote and reports missing remotes distinctly", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = new GitRepository("ws-remove-remote", root, path.join(root, ".git"), gitOnPath!);
      await repo.addRemote("origin", "git@example.invalid:org/repo.git");

      await repo.removeRemote("origin");

      expect(runGit(root, ["remote"]).trim()).toBe("");
      expect((await repo.status()).capabilities.remotes).toEqual([]);
      await expect(repo.removeRemote("origin")).rejects.toMatchObject({
        kind: "remote-not-found",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest(
    "removeRemote detaches the current branch upstream after confirmation path",
    async () => {
      const { client, remoteUrl } = makeClonePair();
      try {
        const repo = new GitRepository(
          "ws-remove-upstream",
          client,
          path.join(client, ".git"),
          gitOnPath!,
        );

        expect((await repo.status()).branch?.upstream).toBe("origin/main");

        await repo.removeRemote("origin");

        const status = await repo.status();
        expect(status.branch?.upstream).toBeNull();
        expect(status.capabilities.remotes).toEqual([]);
      } finally {
        cleanup(client, remoteUrl);
      }
    },
  );
});

/** Creates a repository with a single committed file on main. */
function makeRepoWithCommit(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-remote-"));
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
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-remote-bare-"));
  runGit(remote, ["init", "--bare"]);

  const seed = makeRepoWithCommit();
  runGit(seed, ["remote", "add", "origin", remote]);
  runGit(seed, ["push", "-u", "origin", "main"]);
  fs.rmSync(seed, { recursive: true, force: true });

  const client = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-remote-client-"));
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
