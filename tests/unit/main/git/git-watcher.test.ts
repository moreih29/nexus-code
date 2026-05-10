/**
 * Scenario tests for Git metadata watcher filtering.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { GitWatcher, isIgnoredGitWatchPath } from "../../../../src/main/git/git-watcher";
import { GIT_STATUS_COALESCE_DEBOUNCE_MS } from "../../../../src/shared/timing-constants";

describe("GitWatcher workflow marker handling", () => {
  test("does not ignore workflow marker files or directories", () => {
    const gitDir = path.join(path.sep, "repo", ".git");

    for (const marker of [
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-merge/msgnum",
      "rebase-apply",
      "rebase-apply/next",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
    ]) {
      expect(isIgnoredGitWatchPath(gitDir, path.join(gitDir, marker)), marker).toBe(false);
    }
  });

  test("still ignores noisy lock, objects, and logs paths", () => {
    const gitDir = path.join(path.sep, "repo", ".git");

    expect(isIgnoredGitWatchPath(gitDir, path.join(gitDir, "index.lock"))).toBe(true);
    expect(isIgnoredGitWatchPath(gitDir, path.join(gitDir, "objects", "aa", "object"))).toBe(true);
    expect(isIgnoredGitWatchPath(gitDir, path.join(gitDir, "logs", "HEAD"))).toBe(true);
  });

  test("status coalescer debounce for Git watcher events is at least 100ms", () => {
    expect(GIT_STATUS_COALESCE_DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
  });

  test("registers directory lifecycle events so rebase marker dirs can dirty status", () => {
    const watcher = new GitWatcher(() => {});

    expect(GitWatcher.watchedEvents()).toEqual(["add", "addDir", "change", "unlink", "unlinkDir"]);
    watcher.dispose();
  });
});
