import { describe, expect, test } from "bun:test";
import {
  classifyGitStderr,
  type GitErrorKind,
  gitErrorFromExit,
} from "../../../../src/main/git/git-error";

describe("classifyGitStderr", () => {
  test("classifies unborn-HEAD failures as missing", () => {
    expect(classifyGitStderr("fatal: invalid object name 'HEAD'.\n")).toBe("missing");
  });

  test("classifies pathspec-mismatch as missing", () => {
    expect(classifyGitStderr("fatal: pathspec 'foo.ts' did not match any files\n")).toBe("missing");
  });

  test("classifies unknown-revision as missing", () => {
    expect(classifyGitStderr("fatal: unknown revision or path not in the working tree.\n")).toBe(
      "missing",
    );
  });

  test("auth stderr remains auth (ordering preserved)", () => {
    expect(
      classifyGitStderr("fatal: Authentication failed for 'https://example.com/repo.git/'\n"),
    ).toBe("auth");
  });

  test("local-changes-overwritten beats both conflict and missing", () => {
    // The phrase mentions paths and would have collapsed into either the
    // generic conflict bucket (if classifier ordered conflict before this)
    // or missing. The dedicated kind must win so the renderer can offer the
    // commit/stash recovery path.
    expect(
      classifyGitStderr(
        "error: Your local changes to the following files would be overwritten by checkout:\n\tfoo.ts\n",
      ),
    ).toBe("local-changes-overwritten");
  });

  test("not-a-repository stays not-repo even when stderr also looks pathlike", () => {
    expect(
      classifyGitStderr("fatal: not a git repository (or any of the parent directories): .git\n"),
    ).toBe("not-repo");
  });

  test("classifies index.lock contention as lock-busy", () => {
    expect(
      classifyGitStderr(
        "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository, e.g.\n",
      ),
    ).toBe("lock-busy");
  });

  test("classifies cannot-lock-ref as lock-busy", () => {
    expect(
      classifyGitStderr("error: cannot lock ref 'refs/heads/main': Unable to create...\n"),
    ).toBe("lock-busy");
  });

  test("classifies branch-already-exists as branch-exists", () => {
    expect(classifyGitStderr("fatal: A branch named 'feature/x' already exists.\n")).toBe(
      "branch-exists",
    );
  });

  test("classifies non-fast-forward before generic push rejection", () => {
    expect(
      classifyGitStderr(
        "To example.com:user/repo.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'example.com:user/repo.git'\n",
      ),
    ).toBe("non-fast-forward");
  });

  test("classifies real fetch-first plain push rejection as non-fast-forward", () => {
    const stderr =
      "To github.com:org/repo.git\n" +
      " ! [rejected]        main -> main (fetch first)\n" +
      "error: failed to push some refs to 'github.com:org/repo.git'\n" +
      "hint: Updates were rejected because the remote contains work that you do\n" +
      "hint: not have locally. This is usually caused by another repository pushing\n" +
      "hint: to the same ref. You may want to first integrate the remote changes\n" +
      "hint: (e.g., 'git pull ...') before pushing again.\n";

    const error = gitErrorFromExit({
      args: ["push"],
      stderr,
      exitCode: 1,
      signal: null,
    });

    expect(error.kind).toBe("non-fast-forward");
    expect(error.hint).toEqual({ kind: "pull-then-retry" });
  });

  test("classifies force-push lease-stale as force-push-rejected", () => {
    expect(
      classifyGitStderr(
        " ! [rejected]        main -> main (stale info)\nerror: failed to push some refs\n",
      ),
    ).toBe("force-push-rejected");
  });

  test("attaches fetch-then-force hint to force-with-lease rejection", () => {
    const error = gitErrorFromExit({
      args: ["push", "--force-with-lease"],
      stderr: " ! [rejected]        main -> main (stale info)\nerror: failed to push some refs\n",
      exitCode: 1,
      signal: null,
    });

    expect(error.kind).toBe("force-push-rejected");
    expect(error.hint).toEqual({ kind: "fetch-then-force" });
  });

  test("classifies empty stash as empty-stash (own bucket, not no-local-changes)", () => {
    expect(classifyGitStderr("No stash entries found.\n")).toBe("empty-stash");
  });

  test("classifies amend-with-no-changes as nothing-to-commit", () => {
    expect(classifyGitStderr("nothing to commit, working tree clean\n")).toBe("nothing-to-commit");
  });

  test("classifies amend that would make the commit empty as empty-commit with hint", () => {
    const stderr =
      "You asked to amend the most recent commit, but doing so would make\n" +
      "it empty. You can repeat your command with --allow-empty, or you can\n" +
      'remove the commit entirely with "git reset HEAD^".\n';

    expect(classifyGitStderr(stderr)).toBe("empty-commit");

    const error = gitErrorFromExit({
      args: ["commit", "--amend", "-m", "initial"],
      stderr,
      exitCode: 1,
      signal: null,
    });

    expect(error.kind).toBe("empty-commit");
    expect(error.hint).toEqual({ kind: "allow-empty" });
  });

  test("classifies signing failures without an action hint", () => {
    const error = gitErrorFromExit({
      args: ["commit", "-S", "-m", "signed"],
      stderr: "error: gpg failed to sign the data\nfatal: failed to write commit object\n",
      exitCode: 1,
      signal: null,
    });

    expect(error.kind).toBe("signing-failed");
    expect(error.hint).toBeUndefined();
  });

  test("classifies branch-not-fully-merged as branch-not-fully-merged", () => {
    expect(
      classifyGitStderr(
        "error: The branch 'feature' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D feature'.\n",
      ),
    ).toBe("branch-not-fully-merged");
  });

  test("classifies unborn-repo stash as no-head", () => {
    expect(classifyGitStderr("You do not have the initial commit yet\n")).toBe("no-head");
  });

  test("classifies pull-without-tracking as no-upstream", () => {
    expect(
      classifyGitStderr(
        "There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\n",
      ),
    ).toBe("no-upstream");
  });

  test("classifies push-without-destination as no-remote", () => {
    expect(classifyGitStderr("fatal: No configured push destination.\n")).toBe("no-remote");
  });

  test("classifies prep-task stderr fixtures to stable kinds", () => {
    const fixtures: Array<{ readonly stderr: string; readonly kind: GitErrorKind }> = [
      {
        stderr: "nothing to commit, working tree clean\n",
        kind: "nothing-to-commit",
      },
      {
        stderr:
          "fatal: ambiguous argument 'HEAD^': unknown revision or path not in the working tree.\n",
        kind: "no-parent",
      },
      {
        stderr: "error: gpg failed to sign the data\nfatal: failed to write commit object\n",
        kind: "signing-failed",
      },
      {
        stderr: "Binary file assets/video.mov is too large to display.\n",
        kind: "binary-too-large",
      },
      {
        stderr: "fatal: path 'src/app.ts' exists on disk, but not in 'HEAD'\n",
        kind: "file-not-in-head",
      },
      {
        stderr: "fatal: path '../outside.txt' is outside repository\n",
        kind: "path-not-in-repo",
      },
      {
        stderr: "error: failed to write .gitignore: Permission denied\n",
        kind: "gitignore-write-failed",
      },
      {
        stderr: "conflicts in index. Try without --index.\n",
        kind: "stash-conflict",
      },
      {
        stderr: "fatal: log for 'refs/stash' only has 1 entries\n",
        kind: "stash-not-found",
      },
      {
        stderr: "Aborting commit due to empty commit message.\n",
        kind: "commit-aborted",
      },
      {
        stderr: "error: The branch 'topic' is not fully merged.\n",
        kind: "branch-not-fully-merged",
      },
      {
        stderr: "error: Cannot delete branch 'topic' checked out at '/tmp/other-worktree'\n",
        kind: "branch-checked-out",
      },
      {
        stderr: "fatal: 'bad branch' is not a valid branch name\n",
        kind: "branch-name-invalid",
      },
      {
        stderr: "error: remote origin already exists.\n",
        kind: "remote-exists",
      },
      {
        stderr: "fatal: 'bad remote' is not a valid remote name\n",
        kind: "remote-name-invalid",
      },
      {
        stderr: "fatal: invalid URL 'http://[bad'\n",
        kind: "remote-url-invalid",
      },
      {
        stderr: "error: No such remote: 'origin'\n",
        kind: "remote-not-found",
      },
      {
        stderr: "fatal: tag 'v1.0.0' already exists\n",
        kind: "tag-exists",
      },
      {
        stderr: "error: tag 'v1.0.0' not found.\n",
        kind: "tag-not-found",
      },
      {
        stderr: "fatal: 'bad tag' is not a valid tag name.\n",
        kind: "tag-name-invalid",
      },
      {
        stderr: "fatal: Failed to resolve 'missing-ref' as a valid ref.\n",
        kind: "ref-not-found",
      },
      {
        stderr:
          "fatal: cannot set up tracking information; starting point 'origin/missing' is not a branch\n",
        kind: "upstream-invalid",
      },
      {
        stderr: "fatal: You have not concluded your merge (MERGE_HEAD exists).\n",
        kind: "merge-already-in-progress",
      },
      {
        stderr: "fatal: It seems that there is already a rebase-merge directory.\n",
        kind: "rebase-already-in-progress",
      },
      {
        stderr: "error: cherry-pick is already in progress\n",
        kind: "cherry-pick-already-in-progress",
      },
      {
        stderr: "fatal: no cherry-pick or revert in progress\n",
        kind: "no-operation-in-progress",
      },
      {
        stderr: "error: Committing is not possible because you have unmerged files.\n",
        kind: "unresolved-conflicts",
      },
      {
        stderr: "fatal: refusing to merge unrelated histories\n",
        kind: "unrelated-histories",
      },
      {
        stderr: "fatal: no merge base\n",
        kind: "no-merge-base",
      },
      {
        stderr: "The previous cherry-pick is now empty, possibly due to conflict resolution.\n",
        kind: "empty-commit",
      },
      {
        stderr: "error: path 'src/app.ts' does not have conflicts\n",
        kind: "path-not-conflicted",
      },
      {
        stderr: "error: clone destination '/tmp/repo' invalid\n",
        kind: "clone-destination-invalid",
      },
      {
        stderr: "fatal: could not create work tree dir 'repo': Permission denied\n",
        kind: "clone-destination-not-writable",
      },
      {
        stderr: "fatal: destination path 'repo' already exists and is not an empty directory.\n",
        kind: "clone-destination-exists",
      },
      {
        stderr: "error: repository name '../repo' invalid\n",
        kind: "clone-name-invalid",
      },
      {
        stderr: "fatal: repository 'https://example.invalid/missing.git' does not exist\n",
        kind: "clone-url-invalid",
      },
      {
        stderr:
          "To github.com:org/repo.git\n ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs\n",
        kind: "non-fast-forward",
      },
      {
        stderr:
          "remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: protected branch hook declined\nerror: failed to push some refs\n",
        kind: "protected-branch",
      },
      {
        stderr: "remote: error: pre-receive hook declined\nerror: failed to push some refs\n",
        kind: "pre-receive-hook-rejected",
      },
      {
        stderr: "error: failed to push some refs to 'example.com:org/repo.git'\n",
        kind: "push-rejected",
      },
    ];

    for (const fixture of fixtures) {
      expect(classifyGitStderr(fixture.stderr)).toBe(fixture.kind);
    }
  });
});
