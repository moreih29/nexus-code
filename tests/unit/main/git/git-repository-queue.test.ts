import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newLocalGitRepository } from "./helpers/local-semantic-executor";

const QUEUE_TRIALS = 5;

describe("GitRepository operation queue", () => {
  test("serializes a slow status read before a concurrently requested stage", async () => {
    for (let trial = 0; trial < QUEUE_TRIALS; trial += 1) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-git-queue-"));
      try {
        const gitBin = writeFakeGit(root);
        const repo = newLocalGitRepository(`workspace-${trial}`, root, path.join(root, ".git"), gitBin);

        const slowRead = repo.status();
        const fastWrite = repo.stage(["queued.txt"]);

        await Promise.all([slowRead, fastWrite]);

        expect(readLog(root)).toEqual(["status:start", "status:end", "add:start", "add:end"]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

/** Writes a tiny git-compatible executable that exposes slow status and fast add commands. */
function writeFakeGit(root: string): string {
  const gitBin = path.join(root, "fake-git.sh");
  const logPath = path.join(root, "git-queue.log");
  // The test semantic status executor issues capability subcalls. The fake
  // handles them with empty output so the queue ordering test sees only the
  // user-relevant status:* / add:* trace events.
  const script = `#!/usr/bin/env bash
set -euo pipefail
log=${shellQuote(logPath)}
case "${"$"}1" in
  status)
    printf 'status:start\n' >> "${"$"}log"
    sleep 0.05
    printf 'status:end\n' >> "${"$"}log"
    printf '# branch.head main\\0'
    ;;
  remote)
    : # no remotes configured
    ;;
  stash)
    : # empty stash list
    ;;
  tag)
    : # no tags configured
    ;;
  add)
    printf 'add:start\n' >> "${"$"}log"
    printf 'add:end\n' >> "${"$"}log"
    ;;
  *)
    printf 'unexpected git command: %s\n' "${"$"}1" >&2
    exit 2
    ;;
esac
`;
  fs.writeFileSync(gitBin, script, "utf8");
  fs.chmodSync(gitBin, 0o755);
  return gitBin;
}

/** Reads the operation trace emitted by the fake executable. */
function readLog(root: string): string[] {
  return fs
    .readFileSync(path.join(root, "git-queue.log"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
}

/** Quotes a shell literal for the generated fake git script. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
