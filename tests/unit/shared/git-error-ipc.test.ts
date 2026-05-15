/**
 * Wire-shape tests for src/shared/git-error-ipc.
 *
 * Electron's V8 ValueSerializer drops custom Error own properties so the
 * renderer historically lost `kind`, `hint`, `stderr`, and `argv` from a
 * thrown GitError. The IPC envelope routes those fields through `cause`,
 * which structured clone preserves; these tests pin the wire contract so
 * the main router and renderer client cannot drift.
 */

import { describe, expect, test } from "bun:test";
import {
  gitErrorFromIpcResult,
  IPC_CALL_RESULT_MARK,
  IPC_GIT_ERROR_MARK,
  type IpcGitErrorPayload,
  type IpcGitErrorResult,
  isIpcGitErrorPayload,
  isIpcGitErrorResult,
  rehydrateGitErrorFromCause,
} from "../../../src/shared/git/error-ipc";

describe("isIpcGitErrorPayload", () => {
  test("accepts a payload with the sentinel mark", () => {
    const value: IpcGitErrorPayload = {
      [IPC_GIT_ERROR_MARK]: true,
      kind: "no-upstream",
      stderr: "",
      argv: ["push"],
      hint: { kind: "publish-branch", branch: "feat/x", suggestedRemote: "origin" },
    };
    expect(isIpcGitErrorPayload(value)).toBe(true);
  });

  test("rejects values that lack the sentinel mark", () => {
    expect(isIpcGitErrorPayload({ kind: "no-upstream" })).toBe(false);
    expect(isIpcGitErrorPayload(null)).toBe(false);
    expect(isIpcGitErrorPayload("error")).toBe(false);
    expect(isIpcGitErrorPayload(undefined)).toBe(false);
  });
});

describe("rehydrateGitErrorFromCause", () => {
  test("copies envelope fields onto the error and leaves message/name intact", () => {
    const error = new Error("'feat/x' has no upstream branch.");
    error.name = "GitError";
    (error as { cause?: unknown }).cause = {
      [IPC_GIT_ERROR_MARK]: true,
      kind: "no-upstream",
      stderr: "",
      argv: ["push"],
      hint: { kind: "publish-branch", branch: "feat/x", suggestedRemote: "origin" },
    } satisfies IpcGitErrorPayload;

    const result = rehydrateGitErrorFromCause(error);

    expect(result).toBe(error);
    expect((error as { kind?: string }).kind).toBe("no-upstream");
    expect((error as { stderr?: string }).stderr).toBe("");
    expect((error as { argv?: readonly string[] }).argv).toEqual(["push"]);
    expect((error as { hint?: unknown }).hint).toEqual({
      kind: "publish-branch",
      branch: "feat/x",
      suggestedRemote: "origin",
    });
    expect(error.message).toBe("'feat/x' has no upstream branch.");
    expect(error.name).toBe("GitError");
  });

  test("is a no-op when cause is missing or unrecognized", () => {
    const error = new Error("something else");
    error.name = "Error";
    (error as { cause?: unknown }).cause = { kind: "looks-similar" };

    rehydrateGitErrorFromCause(error);

    expect((error as { kind?: string }).kind).toBeUndefined();
    expect((error as { hint?: unknown }).hint).toBeUndefined();
  });
});

describe("isIpcGitErrorResult", () => {
  test("recognizes envelopes carrying the call-result mark", () => {
    const value: IpcGitErrorResult = {
      [IPC_CALL_RESULT_MARK]: true,
      name: "GitError",
      message: "no upstream",
      kind: "no-upstream",
      stderr: "",
      argv: ["push"],
    };
    expect(isIpcGitErrorResult(value)).toBe(true);
  });

  test("rejects values that lack the mark", () => {
    expect(isIpcGitErrorResult({})).toBe(false);
    expect(isIpcGitErrorResult({ kind: "x", message: "y" })).toBe(false);
    expect(isIpcGitErrorResult(undefined)).toBe(false);
    // The cause-side mark should not collide with the call-result mark.
    expect(isIpcGitErrorResult({ [IPC_GIT_ERROR_MARK]: true })).toBe(false);
  });
});

describe("gitErrorFromIpcResult", () => {
  test("reconstructs a GitError-shaped Error with the typed fields", () => {
    const result: IpcGitErrorResult = {
      [IPC_CALL_RESULT_MARK]: true,
      name: "GitError",
      message: "'feat/x' has no upstream branch.",
      stack: "GitError: ...",
      kind: "no-upstream",
      stderr: "",
      argv: ["push"],
      hint: { kind: "publish-branch", branch: "feat/x", suggestedRemote: "origin" },
    };

    const error = gitErrorFromIpcResult(result);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GitError");
    expect(error.message).toBe("'feat/x' has no upstream branch.");
    expect(error.stack).toBe("GitError: ...");
    expect((error as { kind?: string }).kind).toBe("no-upstream");
    expect((error as { hint?: unknown }).hint).toEqual({
      kind: "publish-branch",
      branch: "feat/x",
      suggestedRemote: "origin",
    });
  });

  test("falls back to GitError name when result.name is empty", () => {
    const result: IpcGitErrorResult = {
      [IPC_CALL_RESULT_MARK]: true,
      name: "",
      message: "anything",
      kind: "unknown",
      stderr: "",
      argv: [],
    };
    const error = gitErrorFromIpcResult(result);
    expect(error.name).toBe("GitError");
  });
});
