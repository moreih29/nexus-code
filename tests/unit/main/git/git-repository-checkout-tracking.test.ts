/**
 * GitRepository.checkoutTracking — verifies the explicit `git checkout
 * --track <remoteRef>` form deterministically materializes a local branch
 * from a remote ref, regardless of `branch.autoSetupMerge` config or how
 * many remotes the repo has. This is the regression that motivated splitting
 * `checkout` and `checkoutTracking` into two ops: bare `git checkout <short>`
 * fails with `pathspec 'main' did not match` when auto-setup is disabled.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRepository } from "../../../../src/main/git/git-repository";
import { localSemanticExecutor, stubMetadataReader } from "./helpers/local-semantic-executor";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository.checkoutTracking", () => {
  realGitTest("creates and checks out a local branch tracking the given remote ref", async () => {
    const { client, remoteUrl } = makeClonePair();
    try {
      const repo = new GitRepository(
        "workspace-track-success",
        client,
        path.join(client, ".git"),
        gitOnPath!,
        localSemanticExecutor(gitOnPath!, path.join(client, ".git")),
        stubMetadataReader,
      );
      // Disable auto-setup-merge so plain `git checkout main` would fail —
      // this is the environment shape that produced the user-visible
      // `pathspec 'main' did not match` regression.
      runGit(client, ["config", "branch.autoSetupMerge", "false"]);

      await repo.checkoutTracking("origin/feature");

      const head = runGit(client, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      expect(head).toBe("feature");

      const upstream = runGit(client, ["rev-parse", "--abbrev-ref", "feature@{upstream}"]).trim();
      expect(upstream).toBe("origin/feature");
    } finally {
      cleanup(client, remoteUrl);
    }
  });

  realGitTest("rejects refs that are not in `<remote>/<branch>` form", async () => {
    const { client, remoteUrl } = makeClonePair();
    try {
      const repo = new GitRepository(
        "workspace-track-shape",
        client,
        path.join(client, ".git"),
        gitOnPath!,
        localSemanticExecutor(gitOnPath!, path.join(client, ".git")),
        stubMetadataReader,
      );

      // Plain `feature` lacks the `<remote>/` segment.
      await expect(repo.checkoutTracking("feature")).rejects.toThrow(/Tracking ref must be in/i);

      // Trailing slash also rejected as malformed.
      await expect(repo.checkoutTracking("origin/")).rejects.toThrow(/Tracking ref must be in/i);

      // Empty / whitespace rejected with a different message.
      await expect(repo.checkoutTracking("   ")).rejects.toThrow(/Tracking ref is required/i);
    } finally {
      cleanup(client, remoteUrl);
    }
  });
});

/**
 * Builds a bare-remote + clone pair so `origin/feature` is a real ref the
 * tests can track without going to the network. Returns absolute paths so
 * the test can clean both directories deterministically.
 */
function makeClonePair(): { client: string; remoteUrl: string } {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-track-remote-"));
  runGit(remote, ["init", "--bare"]);

  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-track-seed-"));
  runGit(seed, ["init", "-b", "main"]);
  runGit(seed, ["config", "user.name", "Nexus Test"]);
  runGit(seed, ["config", "user.email", "nexus@example.invalid"]);
  fs.writeFileSync(path.join(seed, "README.md"), "base\n", "utf8");
  runGit(seed, ["add", "README.md"]);
  runGit(seed, ["commit", "-m", "base"]);
  runGit(seed, ["checkout", "-b", "feature"]);
  fs.writeFileSync(path.join(seed, "feature.txt"), "feature\n", "utf8");
  runGit(seed, ["add", "feature.txt"]);
  runGit(seed, ["commit", "-m", "feature"]);
  runGit(seed, ["checkout", "main"]);
  runGit(seed, ["remote", "add", "origin", remote]);
  runGit(seed, ["push", "origin", "main", "feature"]);
  fs.rmSync(seed, { recursive: true, force: true });

  const client = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-track-client-"));
  runGit(client, ["clone", remote, "."]);
  runGit(client, ["config", "user.name", "Nexus Test"]);
  runGit(client, ["config", "user.email", "nexus@example.invalid"]);

  return { client, remoteUrl: remote };
}

function cleanup(client: string, remoteUrl: string): void {
  fs.rmSync(client, { recursive: true, force: true });
  fs.rmSync(remoteUrl, { recursive: true, force: true });
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
