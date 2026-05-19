/**
 * Scenario-based tests for the AppError taxonomy and the IpcResultKind →
 * AppErrorCategory mapping.
 *
 * These tests verify observable behaviour — constructor output shapes and
 * mapping correctness — not schema internals or TypeScript types.
 */

import { describe, expect, test } from "bun:test";
import {
  appErrorBug,
  appErrorCancelled,
  appErrorFailed,
  appErrorInvalidInput,
} from "../../../src/shared/error/app-error";
import { ipcResultKindToCategory } from "../../../src/shared/ipc/result";

// ---------------------------------------------------------------------------
// AppError constructor helpers
// ---------------------------------------------------------------------------

describe("appErrorInvalidInput", () => {
  test("sets category to invalid-input with only required fields", () => {
    const err = appErrorInvalidInput("Bad branch name");
    expect(err.category).toBe("invalid-input");
    expect(err.message).toBe("Bad branch name");
    expect(err.domain).toBeUndefined();
    expect(err.code).toBeUndefined();
    expect(err.hint).toBeUndefined();
    expect(err.correlationId).toBeUndefined();
  });

  test("accepts domain and code when provided", () => {
    const err = appErrorInvalidInput("Invalid name", {
      domain: "git",
      code: "branch-name-invalid",
    });
    expect(err.category).toBe("invalid-input");
    expect(err.domain).toBe("git");
    expect(err.code).toBe("branch-name-invalid");
  });
});

describe("appErrorCancelled", () => {
  test("sets category to cancelled", () => {
    const err = appErrorCancelled("Operation aborted");
    expect(err.category).toBe("cancelled");
    expect(err.message).toBe("Operation aborted");
  });

  test("preserves correlationId when supplied", () => {
    const err = appErrorCancelled("Aborted", { correlationId: "req-42" });
    expect(err.correlationId).toBe("req-42");
  });
});

describe("appErrorFailed", () => {
  test("sets category to failed and carries a domain code", () => {
    const err = appErrorFailed("Repository not found", {
      domain: "git",
      code: "not-repo",
    });
    expect(err.category).toBe("failed");
    expect(err.domain).toBe("git");
    expect(err.code).toBe("not-repo");
  });

  test("carries a hint for recoverable failures", () => {
    const err = appErrorFailed("No upstream configured", {
      domain: "git",
      code: "no-upstream",
      hint: { kind: "publish-branch", branch: "main", suggestedRemote: "origin" },
    });
    expect(err.hint).toEqual({
      kind: "publish-branch",
      branch: "main",
      suggestedRemote: "origin",
    });
  });

  test("fs error with domain fs and code NOT_FOUND", () => {
    const err = appErrorFailed("File not found", { domain: "fs", code: "NOT_FOUND" });
    expect(err.category).toBe("failed");
    expect(err.domain).toBe("fs");
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("appErrorBug", () => {
  test("sets category to bug", () => {
    const err = appErrorBug("Unexpected null workspace");
    expect(err.category).toBe("bug");
    expect(err.message).toBe("Unexpected null workspace");
  });

  test("carries domain context for debugging", () => {
    const err = appErrorBug("git binary missing from PATH", { domain: "git", code: "git-missing" });
    expect(err.domain).toBe("git");
    expect(err.code).toBe("git-missing");
  });
});

// ---------------------------------------------------------------------------
// IpcResultKind → AppErrorCategory mapping
// ---------------------------------------------------------------------------

describe("ipcResultKindToCategory", () => {
  test("maps cancelled to cancelled", () => {
    expect(ipcResultKindToCategory("cancelled")).toBe("cancelled");
  });

  test("maps invalid-args to invalid-input", () => {
    expect(ipcResultKindToCategory("invalid-args")).toBe("invalid-input");
  });

  test("maps not-found to failed", () => {
    expect(ipcResultKindToCategory("not-found")).toBe("failed");
  });

  test("maps session-expired to failed", () => {
    expect(ipcResultKindToCategory("session-expired")).toBe("failed");
  });

  test("maps auth-failed to failed", () => {
    expect(ipcResultKindToCategory("auth-failed")).toBe("failed");
  });

  test("maps permission-denied to failed", () => {
    expect(ipcResultKindToCategory("permission-denied")).toBe("failed");
  });

  test("maps conflict to failed", () => {
    expect(ipcResultKindToCategory("conflict")).toBe("failed");
  });

  test("falls back to failed for unknown kind strings", () => {
    // Custom kinds introduced by future handlers must not produce 'bug' silently.
    expect(ipcResultKindToCategory("some-future-kind")).toBe("failed");
  });
});
