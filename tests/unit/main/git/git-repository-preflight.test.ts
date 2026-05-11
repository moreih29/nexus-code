/**
 * End-to-end regression tests for GitRepository preflight checks.
 *
 * Each test reproduces a user-facing failure mode reported in production
 * (`pathspec 'main' did not match`, `You do not have the initial commit
 * yet`, `No stash entries found`, `There is no tracking information`,
 * `fatal: No configured push destination`) and asserts that the public
 * GitRepository API now responds with a typed `GitError.kind` plus an
 * actionable `hint` payload instead of the raw stderr.
 *
 * Tests run against real `git` (skipped when not on PATH) so the matrix
 * also covers the auto-track fallback that bare `git checkout <ref>`
 * cannot deliver under all auto-setup configurations.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitError } from "../../../../src/main/git/git-error";
import { GitRepository } from "../../../../src/main/git/git-repository";
import { GitStatusSchema } from "../../../../src/shared/types/git";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository preflight — checkout", () => {
  realGitTest(
    "auto-promotes remote-only ref to `checkout --track` (the `pathspec 'main' did not match` regression)",
    async () => {
      const { client, remoteUrl } = makeClonePair();
      try {
        const repo = new GitRepository(
          "ws-checkout-track-auto",
          client,
          path.join(client, ".git"),
          gitOnPath!,
        );

        // Remove the local `feature` so plain `git checkout feature` would
        // fall back to the historic `pathspec` failure. The preflight should
        // detect the remote-only match and run `checkout --track origin/feature`.
        await repo.checkout("feature");
        runGit(client, ["checkout", "main"]);
        runGit(client, ["branch", "-D", "feature"]);

        await repo.checkout("feature");
        const head = runGit(client, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
        const upstream = runGit(client, ["rev-parse", "--abbrev-ref", "feature@{upstream}"]).trim();
        expect(head).toBe("feature");
        expect(upstream).toBe("origin/feature");
      } finally {
        cleanup(client, remoteUrl);
      }
    },
  );

  realGitTest("rejects checkout of a ref that exists nowhere with no-such-ref", async () => {
    const { client, remoteUrl } = makeClonePair();
    try {
      const repo = new GitRepository(
        "ws-checkout-missing",
        client,
        path.join(client, ".git"),
        gitOnPath!,
      );

      await expect(repo.checkout("definitely-not-a-branch")).rejects.toMatchObject({
        kind: "no-such-ref",
      });
    } finally {
      cleanup(client, remoteUrl);
    }
  });
});

describe("GitRepository — stash on unborn repo classifies as no-head", () => {
  realGitTest(
    "git's 'You do not have the initial commit yet' resolves to kind:no-head",
    async () => {
      const root = makeUnbornRepo();
      try {
        const repo = new GitRepository(
          "ws-stash-unborn",
          root,
          path.join(root, ".git"),
          gitOnPath!,
        );

        try {
          await repo.stash();
          throw new Error("expected throw");
        } catch (error) {
          const gitError = error as GitError;
          expect(gitError.kind).toBe("no-head");
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("GitRepository — stashPop on empty stack classifies as empty-stash", () => {
  realGitTest("git's 'No stash entries found.' resolves to kind:empty-stash", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = new GitRepository(
        "ws-stashpop-empty",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );

      try {
        await repo.stashPop();
        throw new Error("expected throw");
      } catch (error) {
        const gitError = error as GitError;
        expect(gitError.kind).toBe("empty-stash");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GitRepository — pull without upstream classifies via stderr", () => {
  // Note: `git pull` reports the missing tracking information before it
  // checks remote configuration, so a repo with no remote *and* no upstream
  // surfaces the same `no-upstream` stderr as a repo that just lacks an
  // upstream for the current branch. The renderer disambiguates via
  // `RepoCapabilities` (hasRemote=false → Pull is disabled before click).
  realGitTest("fresh local repo without remote → no-upstream", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = new GitRepository(
        "ws-pull-no-upstream-bare",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );

      try {
        await repo.pull();
        throw new Error("expected throw");
      } catch (error) {
        const gitError = error as GitError;
        expect(gitError.kind).toBe("no-upstream");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("classifies pull on a branch without upstream as no-upstream", async () => {
    const { client, remoteUrl } = makeClonePair();
    try {
      const repo = new GitRepository(
        "ws-pull-no-upstream",
        client,
        path.join(client, ".git"),
        gitOnPath!,
      );

      // Create a local branch with no upstream and switch to it so the
      // pull operation surfaces git's "no tracking information" stderr.
      runGit(client, ["checkout", "-b", "no-upstream-branch"]);

      try {
        await repo.pull();
        throw new Error("expected throw");
      } catch (error) {
        const gitError = error as GitError;
        expect(gitError.kind).toBe("no-upstream");
      }
    } finally {
      cleanup(client, remoteUrl);
    }
  });
});

describe("GitRepository — push without remote/upstream classifies via stderr", () => {
  realGitTest("classifies push with no remote as no-remote", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = new GitRepository(
        "ws-push-no-remote",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );

      try {
        await repo.push();
        throw new Error("expected throw");
      } catch (error) {
        const gitError = error as GitError;
        expect(gitError.kind).toBe("no-remote");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("classifies push on a branch without upstream as no-upstream", async () => {
    const { client, remoteUrl } = makeClonePair();
    try {
      const repo = new GitRepository(
        "ws-push-no-upstream",
        client,
        path.join(client, ".git"),
        gitOnPath!,
      );
      runGit(client, ["checkout", "-b", "no-upstream-branch"]);

      try {
        await repo.push();
        throw new Error("expected throw");
      } catch (error) {
        const gitError = error as GitError;
        expect(gitError.kind).toBe("no-upstream");
      }
    } finally {
      cleanup(client, remoteUrl);
    }
  });

  realGitTest("publish=true sets upstream and pushes against the first remote", async () => {
    const { client, remoteUrl } = makeClonePair();
    try {
      const repo = new GitRepository(
        "ws-push-publish",
        client,
        path.join(client, ".git"),
        gitOnPath!,
      );
      runGit(client, ["checkout", "-b", "feature-publish"]);
      fs.writeFileSync(path.join(client, "publish.txt"), "publish\n", "utf8");
      runGit(client, ["add", "publish.txt"]);
      runGit(client, ["commit", "-m", "publish"]);

      await repo.push(false, true);

      const upstream = runGit(client, [
        "rev-parse",
        "--abbrev-ref",
        "feature-publish@{upstream}",
      ]).trim();
      expect(upstream).toBe("origin/feature-publish");
    } finally {
      cleanup(client, remoteUrl);
    }
  });
});

describe("GitRepository.readStatus — capabilities", () => {
  realGitTest("populates remotes, stashCount, and hasHEAD on a normal repo", async () => {
    const { client, remoteUrl } = makeClonePair();
    try {
      const repo = new GitRepository(
        "ws-capabilities-clone",
        client,
        path.join(client, ".git"),
        gitOnPath!,
      );

      // Create one stash so the snapshot has work to count.
      fs.writeFileSync(path.join(client, "scratch.txt"), "scratch\n", "utf8");
      runGit(client, ["add", "scratch.txt"]);
      runGit(client, ["stash", "push", "-m", "scratch"]);

      const status = await repo.status();
      expect(status.capabilities.hasHEAD).toBe(true);
      expect(status.capabilities.remotes).toEqual(["origin"]);
      expect(status.capabilities.stashCount).toBe(1);
    } finally {
      cleanup(client, remoteUrl);
    }
  });

  realGitTest("reports hasHEAD=false on an unborn repository", async () => {
    const root = makeUnbornRepo();
    try {
      const repo = new GitRepository(
        "ws-capabilities-unborn",
        root,
        path.join(root, ".git"),
        gitOnPath!,
      );

      const status = await repo.status();
      expect(status.capabilities.hasHEAD).toBe(false);
      expect(status.capabilities.remotes).toEqual([]);
      expect(status.capabilities.stashCount).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("returns schema-valid integer lastFetchedAt when FETCH_HEAD exists", async () => {
    const { client, remoteUrl } = makeClonePair();
    try {
      const repo = new GitRepository(
        "ws-status-last-fetch",
        client,
        path.join(client, ".git"),
        gitOnPath!,
      );
      runGit(client, ["fetch", "origin"]);

      const status = await repo.status();

      expect(status.lastFetchedAt).not.toBeNull();
      expect(Number.isInteger(status.lastFetchedAt)).toBe(true);
      expect(GitStatusSchema.safeParse(status).success).toBe(true);
    } finally {
      cleanup(client, remoteUrl);
    }
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates an initialized repository with no commits — the unborn HEAD case. */
function makeUnbornRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-preflight-unborn-"));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  return root;
}

/** Creates a repository with a single committed file. */
function makeRepoWithCommit(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-preflight-commit-"));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  runGit(root, ["add", "README.md"]);
  runGit(root, ["commit", "-m", "base"]);
  return root;
}

/**
 * Builds a bare-remote + clone pair so `origin/feature` and `origin/main`
 * are real refs without any network involvement. Returns absolute paths so
 * the caller can clean both directories deterministically.
 */
function makeClonePair(): { client: string; remoteUrl: string } {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-preflight-remote-"));
  runGit(remote, ["init", "--bare"]);

  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-preflight-seed-"));
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

  const client = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-preflight-client-"));
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
