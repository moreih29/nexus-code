/**
 * Scenario tests for task-6 commit-area backend operations.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitError } from "../../../../src/main/git/git-error";
import { GitRepository } from "../../../../src/main/git/git-repository";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("GitRepository commit actions", () => {
  it("passes sticky commit option flags to commit, amend, and empty commit commands", async () => {
    const fixture = makeFakeRepo();
    try {
      const repo = new GitRepository(
        "ws-commit-options",
        fixture.root,
        fixture.gitDir,
        fixture.gitBin,
      );

      await repo.commit("signed subject", { sign: true, signoff: true, noVerify: true });
      await repo.commitAmend(undefined, { sign: true });
      await repo.commitEmpty("empty subject", { signoff: true, noVerify: true });

      const log = readLog(fixture.root);
      expect(log).toContain("commit -S --signoff --no-verify -m signed subject|editor=");
      expect(log.some((line) => /^commit --amend -S -e\|editor=.+/.test(line))).toBe(true);
      expect(log).toContain("commit --allow-empty --signoff --no-verify -m empty subject|editor=");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("maps undo-last-commit on a root commit to no-parent and does not reset", async () => {
    const fixture = makeFakeRepo({ parentExists: false });
    try {
      const repo = new GitRepository("ws-undo-root", fixture.root, fixture.gitDir, fixture.gitBin);

      try {
        await repo.undoLastCommit();
        throw new Error("expected undoLastCommit to throw");
      } catch (error) {
        expect((error as GitError).kind).toBe("no-parent");
      }

      expect(readLog(fixture.root)).not.toContain("reset --soft HEAD^|editor=");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("GitRepository sync", () => {
  it("holds one queue slot for pull then push so status cannot interleave", async () => {
    const fixture = makeFakeRepo({ slowSync: true });
    try {
      const repo = new GitRepository("ws-sync-queue", fixture.root, fixture.gitDir, fixture.gitBin);

      await Promise.all([repo.sync(), repo.status()]);

      const interesting = readLog(fixture.root).filter((line) => /^(pull|push|status)/.test(line));
      expect(interesting).toEqual([
        "pull:start",
        "pull:end",
        "push:start",
        "push:end",
        "status --porcelain=v2 -z -b --untracked-files=all --renames|editor=",
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns an error envelope and skips push when pull fails", async () => {
    const fixture = makeFakeRepo({ pullFails: true });
    try {
      const repo = new GitRepository(
        "ws-sync-conflict",
        fixture.root,
        fixture.gitDir,
        fixture.gitBin,
      );

      const result = await repo.sync();

      expect(result.pulled).toBe("error");
      expect(result.pushed).toBe("skipped");
      expect(result.pullError?.kind).toBe("conflict");

      const log = readLog(fixture.root);
      expect(log).toContain("pull:start");
      expect(log.some((line) => line.startsWith("push"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

interface FakeRepoOptions {
  readonly parentExists?: boolean;
  readonly pullFails?: boolean;
  readonly slowSync?: boolean;
}

/** Creates a temp repository root with a git-compatible shell fixture. */
function makeFakeRepo(options: FakeRepoOptions = {}): {
  root: string;
  gitDir: string;
  gitBin: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-task6-"));
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(gitDir, { recursive: true });

  const gitBin = path.join(root, "fake-git.sh");
  fs.writeFileSync(gitBin, fakeGitScript(root, options), "utf8");
  fs.chmodSync(gitBin, 0o755);
  return { root, gitDir, gitBin };
}

/** Emits a fake git executable that logs argv and simulates task-6 commands. */
function fakeGitScript(root: string, options: FakeRepoOptions): string {
  const logPath = path.join(root, "git.log");
  return `#!/usr/bin/env bash
set -euo pipefail
log=${shellQuote(logPath)}
parent_exists=${options.parentExists === false ? "0" : "1"}
pull_fails=${options.pullFails ? "1" : "0"}
slow_sync=${options.slowSync ? "1" : "0"}
log_args() { printf '%s|editor=%s\n' "$*" "${"${"}GIT_EDITOR:-}" >> "${"$"}log"; }
case "${"$"}1" in
  status)
    log_args "$@"
    printf '# branch.oid ${SHA}\\0# branch.head main\\0# branch.upstream origin/main\\0'
    ;;
  remote)
    log_args "$@"
    printf 'origin\n'
    ;;
  stash)
    log_args "$@"
    ;;
  tag)
    log_args "$@"
    ;;
  commit)
    log_args "$@"
    ;;
  rev-parse)
    log_args "$@"
    if [[ "${"$"}2" == "--verify" ]]; then
      if [[ "${"$"}parent_exists" == "1" ]]; then
        printf '${SHA}\n'
      else
        printf "fatal: ambiguous argument 'HEAD^': unknown revision or path not in the working tree.\n" >&2
        exit 1
      fi
    else
      printf '${SHA}\n'
    fi
    ;;
  reset)
    log_args "$@"
    ;;
  pull)
    printf 'pull:start\n' >> "${"$"}log"
    if [[ "${"$"}slow_sync" == "1" ]]; then sleep 0.05; fi
    if [[ "${"$"}pull_fails" == "1" ]]; then
      printf 'CONFLICT (content): Merge conflict in README.md\n' >&2
      exit 1
    fi
    printf 'pull:end\n' >> "${"$"}log"
    ;;
  push)
    printf 'push:start\n' >> "${"$"}log"
    if [[ "${"$"}slow_sync" == "1" ]]; then sleep 0.05; fi
    printf 'push:end\n' >> "${"$"}log"
    ;;
  *)
    printf 'unexpected git command: %s\n' "${"$"}1" >&2
    exit 2
    ;;
esac
`;
}

/** Reads fake git log lines, returning an empty list before the first command. */
function readLog(root: string): string[] {
  const logPath = path.join(root, "git.log");
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

/** Quotes a shell literal for the generated fake git script. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
