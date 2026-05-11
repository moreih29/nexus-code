/**
 * Unit tests for the trimmed git-preflight surface.
 *
 * After Stage 4 of the git stabilization cycle, preflight kept only
 * `assertHasHead` (used by `push --publish` to fail fast before building
 * argv with a missing branch name) and `resolveCheckoutTarget` (auto-track
 * promotion for remote-only refs — a feature, not a precondition guard).
 * Other situations (`no-remote`, `no-upstream`, `empty-stash`,
 * `no-local-changes`) now surface through stderr classification.
 */

import { describe, expect, test } from "bun:test";
import type { GitError } from "../../../../src/main/git/git-error";
import { assertHasHead, resolveCheckoutTarget } from "../../../../src/main/git/git-preflight";
import type { BranchInfo, BranchList } from "../../../../src/shared/types/git";

const headBranch: BranchInfo = {
  current: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  isUnborn: false,
};

const unbornBranch: BranchInfo = { ...headBranch, isUnborn: true };

describe("assertHasHead", () => {
  test("rejects null branch with no-head + make-initial-commit hint", () => {
    try {
      assertHasHead(null);
      throw new Error("expected throw");
    } catch (error) {
      const gitError = error as GitError;
      expect(gitError.kind).toBe("no-head");
      expect(gitError.hint).toEqual({ kind: "make-initial-commit" });
    }
  });

  test("rejects unborn branch (git init without first commit)", () => {
    try {
      assertHasHead(unbornBranch);
      throw new Error("expected throw");
    } catch (error) {
      const gitError = error as GitError;
      expect(gitError.kind).toBe("no-head");
      expect(gitError.hint).toEqual({ kind: "make-initial-commit" });
    }
  });

  test("passes when branch exists with at least one commit", () => {
    expect(() => assertHasHead(headBranch)).not.toThrow();
  });
});

describe("resolveCheckoutTarget", () => {
  function buildList(local: string[], remote: string[]): BranchList {
    return { current: headBranch, local, remote };
  }

  test("routes a local-matching ref to the plain checkout path", () => {
    const target = resolveCheckoutTarget("main", buildList(["main", "feature"], []));
    expect(target).toEqual({ kind: "local", ref: "main" });
  });

  test("auto-promotes a remote-only ref to checkout --track when unique", () => {
    const target = resolveCheckoutTarget(
      "main",
      buildList(["feature"], ["origin/main", "origin/feature"]),
    );
    expect(target).toEqual({ kind: "track", remoteRef: "origin/main" });
  });

  test("rejects ambiguous remote refs with the candidate list", () => {
    try {
      resolveCheckoutTarget("main", buildList(["feature"], ["origin/main", "fork/main"]));
      throw new Error("expected throw");
    } catch (error) {
      const gitError = error as GitError;
      expect(gitError.kind).toBe("no-such-ref");
      expect(gitError.hint).toEqual({
        kind: "ambiguous-remote",
        candidates: ["origin/main", "fork/main"],
      });
    }
  });

  test("rejects refs that match no local or remote with no-such-ref", () => {
    try {
      resolveCheckoutTarget("nonexistent", buildList(["main"], ["origin/main"]));
      throw new Error("expected throw");
    } catch (error) {
      const gitError = error as GitError;
      expect(gitError.kind).toBe("no-such-ref");
      expect(gitError.hint).toBeUndefined();
    }
  });

  test("rejects empty/whitespace ref with a clear required message", () => {
    expect(() => resolveCheckoutTarget("   ", buildList(["main"], []))).toThrow(/required/i);
  });

  test("local match wins over remote even when both exist", () => {
    const target = resolveCheckoutTarget("main", buildList(["main"], ["origin/main", "fork/main"]));
    expect(target).toEqual({ kind: "local", ref: "main" });
  });
});
