import { describe, expect, test } from "bun:test";
import { classifyGitStderr } from "../../../../src/main/git/git-error";

describe("classifyGitStderr", () => {
  test("classifies unborn-HEAD failures as missing", () => {
    expect(classifyGitStderr("fatal: invalid object name 'HEAD'.\n")).toBe("missing");
  });

  test("classifies pathspec-mismatch as missing", () => {
    expect(classifyGitStderr("fatal: pathspec 'foo.ts' did not match any files\n")).toBe("missing");
  });

  test("classifies unknown-revision as missing", () => {
    expect(
      classifyGitStderr("fatal: unknown revision or path not in the working tree.\n"),
    ).toBe("missing");
  });

  test("auth stderr remains auth (ordering preserved)", () => {
    expect(classifyGitStderr("fatal: Authentication failed for 'https://example.com/repo.git/'\n")).toBe(
      "auth",
    );
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
    expect(classifyGitStderr("fatal: not a git repository (or any of the parent directories): .git\n")).toBe(
      "not-repo",
    );
  });

  test("classifies index.lock contention as lock-busy", () => {
    expect(
      classifyGitStderr(
        "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository, e.g.\n",
      ),
    ).toBe("lock-busy");
  });

  test("classifies cannot-lock-ref as lock-busy", () => {
    expect(classifyGitStderr("error: cannot lock ref 'refs/heads/main': Unable to create...\n")).toBe(
      "lock-busy",
    );
  });

  test("classifies branch-already-exists as branch-exists", () => {
    expect(
      classifyGitStderr("fatal: A branch named 'feature/x' already exists.\n"),
    ).toBe("branch-exists");
  });

  test("classifies non-fast-forward as push-rejected", () => {
    expect(
      classifyGitStderr(
        "To example.com:user/repo.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'example.com:user/repo.git'\n",
      ),
    ).toBe("push-rejected");
  });

  test("classifies force-push lease-stale as force-push-rejected", () => {
    expect(
      classifyGitStderr(
        " ! [rejected]        main -> main (stale info)\nerror: failed to push some refs\n",
      ),
    ).toBe("force-push-rejected");
  });

  test("classifies empty stash as empty-stash (own bucket, not no-local-changes)", () => {
    expect(classifyGitStderr("No stash entries found.\n")).toBe("empty-stash");
  });

  test("classifies amend-with-no-changes as no-local-changes", () => {
    expect(classifyGitStderr("nothing to commit, working tree clean\n")).toBe(
      "no-local-changes",
    );
  });

  test("classifies branch-not-merged as branch-not-merged", () => {
    expect(
      classifyGitStderr(
        "error: The branch 'feature' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D feature'.\n",
      ),
    ).toBe("branch-not-merged");
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
});
