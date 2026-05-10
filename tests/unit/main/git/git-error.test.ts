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

  test("conflict-mentioning-paths beats missing classification", () => {
    // 'would be overwritten by checkout' mentions paths; conflict must win
    // because checking out into a dirty tree is a conflict, not a missing-object case.
    expect(
      classifyGitStderr(
        "error: Your local changes to the following files would be overwritten by checkout:\n\tfoo.ts\n",
      ),
    ).toBe("conflict");
  });

  test("not-a-repository stays not-repo even when stderr also looks pathlike", () => {
    expect(classifyGitStderr("fatal: not a git repository (or any of the parent directories): .git\n")).toBe(
      "not-repo",
    );
  });
});
