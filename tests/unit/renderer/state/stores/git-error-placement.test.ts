/**
 * gitErrorPlacement / summarizeGitError — where a git failure is shown and
 * the line it leads with.
 */
import { describe, expect, it } from "bun:test";
import {
  gitErrorPlacement,
  summarizeGitError,
} from "../../../../../src/renderer/state/stores/git/error-placement";
import type { GitStoreError } from "../../../../../src/renderer/state/stores/git/types";

function error(overrides: Partial<GitStoreError>): GitStoreError {
  return { kind: "unknown", message: "git failed", operation: "pull", ...overrides };
}

describe("gitErrorPlacement", () => {
  it("keeps load and refresh failures in the panel only", () => {
    expect(gitErrorPlacement(error({ operation: undefined }))).toBe("status");
    expect(gitErrorPlacement(error({ operation: "refresh" }))).toBe("status");
    expect(gitErrorPlacement(error({ operation: "init" }))).toBe("status");
  });

  it("keeps failures the panel recovers from in the panel", () => {
    expect(gitErrorPlacement(error({ kind: "non-fast-forward", operation: "push" }))).toBe("panel");
    expect(gitErrorPlacement(error({ kind: "conflict", operation: "pull" }))).toBe("panel");
    expect(gitErrorPlacement(error({ operation: "continueOp" }))).toBe("panel");
    expect(gitErrorPlacement(error({ kind: "auth", operation: "fetch" }))).toBe("panel");
    expect(
      gitErrorPlacement(error({ message: "fatal: Authentication failed for 'https://x'" })),
    ).toBe("panel");
  });

  it("sends any other failed action to a toast", () => {
    expect(gitErrorPlacement(error({ kind: "unknown", operation: "sync" }))).toBe("toast");
    expect(gitErrorPlacement(error({ kind: "commit-aborted", operation: "commit" }))).toBe("toast");
    expect(
      gitErrorPlacement(error({ kind: "local-changes-overwritten", operation: "checkout" })),
    ).toBe("toast");
  });
});

describe("summarizeGitError", () => {
  it("keeps a one-line message and its details as they are", () => {
    expect(
      summarizeGitError(error({ message: "No upstream configured.", details: "stderr" })),
    ).toEqual({ summary: "No upstream configured.", details: "stderr" });
  });

  it("leads raw git output with its first fatal or error line and keeps all of it as details", () => {
    const message = [
      "From /home/dev/remote",
      "   fe8ab8b..fc00e29  main       -> origin/main",
      "hint: You have divergent branches and need to specify how to reconcile them.",
      "fatal: need to specify how to reconcile divergent branches.",
    ].join("\n");

    expect(summarizeGitError(error({ message }))).toEqual({
      summary: "Need to specify how to reconcile divergent branches.",
      details: message,
    });
  });

  it("falls back to the first line and appends separate details", () => {
    const message = "pre-commit hook failed\nlint: 3 problems";

    expect(summarizeGitError(error({ message, details: "exit 1" }))).toEqual({
      summary: "Pre-commit hook failed",
      details: `${message}\n\nexit 1`,
    });
  });
});
