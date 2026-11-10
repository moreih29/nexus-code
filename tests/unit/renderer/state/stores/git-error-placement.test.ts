/**
 * summarizeGitError — the line a git failure leads with.
 */
import { describe, expect, it } from "bun:test";
import { summarizeGitError } from "../../../../../src/renderer/state/stores/git/error-placement";
import type { GitStoreError } from "../../../../../src/renderer/state/stores/git/types";

function error(overrides: Partial<GitStoreError>): GitStoreError {
  return { kind: "unknown", message: "git failed", operation: "pull", ...overrides };
}

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
