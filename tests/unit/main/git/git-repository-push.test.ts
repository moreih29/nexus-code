/**
 * Push guardrail tests for GitRepository argv construction.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newLocalGitRepository } from "./helpers/local-semantic-executor";

describe("GitRepository push guardrails", () => {
  it("uses --force-with-lease for explicit force pushes", async () => {
    const fixture = makeFakeRepo();
    try {
      const repo = newLocalGitRepository("ws-push-lease", fixture.root, fixture.gitDir, fixture.gitBin);

      await repo.push(true);

      expect(readLog(fixture.root)[0]).toMatch("push --force-with-lease|askpass=");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("publishes to the first configured remote when multiple remotes exist", async () => {
    const fixture = makeFakeRepo();
    try {
      const repo = newLocalGitRepository(
        "ws-publish-first",
        fixture.root,
        fixture.gitDir,
        fixture.gitBin,
      );

      await repo.push(false, true);

      expect(readLog(fixture.root).at(-1)).toMatch("push -u upstream main|askpass=");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

});

/** Creates a temp repository root with a push-logging git executable. */
function makeFakeRepo(): { root: string; gitDir: string; gitBin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-push-guard-"));
  const gitDir = path.join(root, ".git");
  fs.mkdirSync(gitDir, { recursive: true });

  const gitBin = path.join(root, "fake-git.sh");
  const logPath = path.join(root, "git.log");
  fs.writeFileSync(
    gitBin,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s|askpass=%s\n' "$*" "${"${"}GIT_ASKPASS:-}" >> ${shellQuote(logPath)}
case "$*" in
  "status --porcelain=v2 -z -b --untracked-files=all --renames")
    printf '# branch.oid abcdef0123456789abcdef0123456789abcdef01\\0# branch.head main\\0'
    ;;
  "remote")
    printf 'upstream\\norigin\\n'
    ;;
  "stash list" | "tag --list")
    ;;
esac
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

/** Quotes a shell literal for generated test scripts. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
