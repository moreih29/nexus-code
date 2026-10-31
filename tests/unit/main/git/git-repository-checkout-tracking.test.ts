/**
 * GitRepository.checkoutTracking — verifies the explicit `git checkout
 * --track <remoteRef>` form deterministically materializes a local branch
 * from a remote ref, regardless of `branch.autoSetupMerge` config or how
 * many remotes the repo has. This is the regression that motivated splitting
 * `checkout` and `checkoutTracking` into two ops: bare `git checkout <short>`
 * fails with `pathspec 'main' did not match` when auto-setup is disabled.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRepository } from "../../../../src/main/features/git/domain/repository";
import { localSemanticExecutor, stubMetadataReader } from "./helpers/local-semantic-executor";

const gitOnPath = findGitOnPath();
const realGitDescribe = gitOnPath ? describe : describe.skip;

describe("GitRepository.checkoutTracking ref shape", () => {
  test("rejects refs that are not in `<remote>/<branch>` form", async () => {
    // Validation throws before any git process starts, so no repo is needed.
    const repo = new GitRepository(
      "workspace-track-shape",
      "/nonexistent",
      "/nonexistent/.git",
      "git",
      localSemanticExecutor("git"),
      stubMetadataReader,
    );

    // Plain `feature` lacks the `<remote>/` segment.
    await expect(repo.checkoutTracking("feature")).rejects.toThrow(/Tracking ref must be in/i);

    // Trailing slash also rejected as malformed.
    await expect(repo.checkoutTracking("origin/")).rejects.toThrow(/Tracking ref must be in/i);

    // Empty / whitespace rejected with a different message.
    await expect(repo.checkoutTracking("   ")).rejects.toThrow(/Tracking ref is required/i);
  });
});

// The tests below share one clone. listBranches reads only remote refs, so
// the local branch checkoutTracking creates does not affect it.
realGitDescribe("GitRepository against a real clone", () => {
  let clonePair: { client: string; remoteUrl: string };
  let repo: GitRepository;

  beforeAll(() => {
    clonePair = makeClonePair();
    const { client } = clonePair;
    repo = new GitRepository(
      "workspace-real-clone",
      client,
      path.join(client, ".git"),
      gitOnPath!,
      localSemanticExecutor(gitOnPath!, path.join(client, ".git")),
      stubMetadataReader,
    );
  });

  afterAll(() => {
    cleanup(clonePair.client, clonePair.remoteUrl);
  });

  test("checkoutTracking creates and checks out a local branch tracking the given remote ref", async () => {
    const { client } = clonePair;
    // Disable auto-setup-merge so plain `git checkout main` would fail —
    // this is the environment shape that produced the user-visible
    // `pathspec 'main' did not match` regression.
    runGit(client, ["config", "branch.autoSetupMerge", "false"]);

    await repo.checkoutTracking("origin/feature");

    const head = runGit(client, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    expect(head).toBe("feature");

    const upstream = runGit(client, ["rev-parse", "--abbrev-ref", "feature@{upstream}"]).trim();
    expect(upstream).toBe("origin/feature");
  });

  test("listBranches lists remote branches without the remote HEAD alias", async () => {
    const { client } = clonePair;
    // A clone records `refs/remotes/origin/HEAD`, which recent git
    // shortens to a bare `origin`.
    expect(runGit(client, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim()).toBe(
      "refs/remotes/origin/main",
    );

    const branches = await repo.listBranches();

    expect([...branches.remote].sort()).toEqual(["origin/feature", "origin/main"]);
  });
});

/**
 * Builds a remote + clone pair so `origin/feature` is a real ref the tests
 * can track without going to the network. `main` and `feature` share one
 * empty commit: the tests need the refs, not distinct content. Returns
 * absolute paths so the test can clean both directories deterministically.
 */
function makeClonePair(): { client: string; remoteUrl: string } {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-track-remote-"));
  runGit(remote, ["init", "-b", "main"]);
  runGit(remote, [
    "-c",
    "user.name=Nexus Test",
    "-c",
    "user.email=nexus@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  ]);
  runGit(remote, ["branch", "feature"]);

  const client = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-track-client-"));
  runGit(client, ["clone", remote, "."]);

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
