import { describe, expect, test } from "bun:test";
import {
  GitError,
  gitErrorFromAgent,
  gitErrorFromExit,
  outputTooLargeGitError,
} from "../../../../src/main/features/git/domain/error";

describe("gitErrorFromAgent", () => {
  test("wraps an agent-classified envelope as a GitError marker", () => {
    const error = gitErrorFromAgent(
      {
        stdout: "",
        stderr: "To example.invalid/repo.git\n ! [rejected] main -> main (non-fast-forward)\n",
        code: 1,
        errorKind: "non-fast-forward",
        errorHint: { kind: "pull-then-retry" },
        errorMessage: "Push rejected — pull first",
      },
      ["push", "origin", "main"],
    );

    expect(error).toBeInstanceOf(GitError);
    expect(error.name).toBe("GitError");
    expect(error.kind).toBe("non-fast-forward");
    expect(error.message).toBe("Push rejected — pull first");
    expect(error.hint).toEqual({ kind: "pull-then-retry" });
    expect(error.argv).toEqual(["push", "origin", "main"]);
    expect(error.code).toBe(1);
    expect(error.exitCode).toBe(1);
    expect(error.signal).toBeNull();
  });

  test("uses unknown when a legacy envelope lacks agent classification", () => {
    const error = gitErrorFromAgent(
      {
        stdout: "",
        stderr: "fatal: plain stderr\n",
        code: 128,
      },
      ["rev-parse", "HEAD"],
    );

    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe("unknown");
    expect(error.message).toBe("fatal: plain stderr");
  });

  test("treats output-too-large data envelopes as GitError failures even with code 0", () => {
    const error = gitErrorFromAgent(
      {
        stdout: "",
        stderr: "",
        code: 0,
        errorKind: "output-too-large",
        errorMessage: "Git output exceeded 10 MB limit",
      },
      ["log", "--all"],
    );

    expect(error.kind).toBe("output-too-large");
    expect(error.message).toBe("Git output exceeded 10 MB limit");
    expect(error.code).toBe(0);
  });
});

describe("legacy local GitError helpers", () => {
  test("preserve instanceof GitError for local output cap and process exits", () => {
    const tooLarge = outputTooLargeGitError({ args: ["log"], limitBytes: 10 * 1024 * 1024 });
    expect(tooLarge).toBeInstanceOf(GitError);
    expect(tooLarge.kind).toBe("output-too-large");

    const localExit = gitErrorFromExit({
      args: ["status"],
      stderr: "fatal: not a git repository\n",
      exitCode: 128,
      signal: null,
    });
    expect(localExit).toBeInstanceOf(GitError);
    expect(localExit.kind).toBe("unknown");
    expect(localExit.message).toBe("fatal: not a git repository");
  });
});
