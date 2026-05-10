/**
 * Scenario tests for Git tag management operations.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitError } from "../../../../src/main/git/git-error";
import { GitRepository } from "../../../../src/main/git/git-repository";

const gitOnPath = findGitOnPath();
const realGitTest = gitOnPath ? test : test.skip;

describe("GitRepository tag ops", () => {
  realGitTest("lists lightweight and annotated tags with stable metadata", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = new GitRepository("ws-tags-list", root, path.join(root, ".git"), gitOnPath!);
      const headSha = runGit(root, ["rev-parse", "HEAD"]).trim();

      await repo.createTag("v-light");
      await repo.createTag("v-annotated", { message: "release notes" });

      const tags = await repo.listTags();
      const light = tags.find((tag) => tag.name === "v-light");
      const annotated = tags.find((tag) => tag.name === "v-annotated");

      expect(light).toMatchObject({
        name: "v-light",
        sha: headSha,
        message: null,
        type: "lightweight",
        taggerDate: null,
      });
      expect(annotated).toMatchObject({
        name: "v-annotated",
        sha: headSha,
        message: "release notes",
        type: "annotated",
      });
      expect(annotated?.taggerDate).toBeNumber();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("creates lightweight and annotated tags and maps duplicate/bad-ref errors", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = new GitRepository("ws-tags-create", root, path.join(root, ".git"), gitOnPath!);

      await repo.createTag("v-light");
      expect(runGit(root, ["cat-file", "-t", "v-light"]).trim()).toBe("commit");

      await repo.createTag("v-annotated", { message: "release notes" });
      expect(runGit(root, ["cat-file", "-t", "v-annotated"]).trim()).toBe("tag");

      await expect(repo.createTag("v-light")).rejects.toMatchObject({ kind: "tag-exists" });
      await expect(repo.createTag("v-missing", { ref: "definitely-missing" })).rejects.toMatchObject(
        { kind: "ref-not-found" },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  realGitTest("deletes local tags and maps nonexistent tags", async () => {
    const root = makeRepoWithCommit();
    try {
      const repo = new GitRepository("ws-tags-delete", root, path.join(root, ".git"), gitOnPath!);

      await repo.createTag("v-delete");
      await repo.deleteTag("v-delete");
      expect(runGit(root, ["tag", "--list", "v-delete"]).trim()).toBe("");

      try {
        await repo.deleteTag("v-delete");
        throw new Error("expected deleteTag to reject nonexistent tag");
      } catch (error) {
        expect((error as GitError).kind).toBe("tag-not-found");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleteRemoteTag uses the prompt-capable helper environment", async () => {
    const fixture = makeFakeRepo();
    try {
      const repo = new GitRepository(
        "ws-delete-remote-tag",
        fixture.root,
        fixture.gitDir,
        fixture.gitBin,
      );

      await repo.deleteRemoteTag("origin", "v1.0.0");

      expect(readLog(fixture.root)[0]).toMatch(
        /^push origin :refs\/tags\/v1\.0\.0\|askpass=.+\|terminal=0$/,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

/** Creates a repository with a single committed file on main. */
function makeRepoWithCommit(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-tags-"));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "Nexus Test"]);
  runGit(root, ["config", "user.email", "nexus@example.invalid"]);
  fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  runGit(root, ["add", "README.md"]);
  runGit(root, ["commit", "-m", "base"]);
  return root;
}

/** Creates a fake repo with a git-compatible script that logs push env. */
function makeFakeRepo(): { root: string; gitDir: string; gitBin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-delete-remote-tag-"));
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
