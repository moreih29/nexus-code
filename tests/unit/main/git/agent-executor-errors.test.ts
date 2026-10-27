/**
 * Failures of dedicated agent git methods (push, pull, tag, stash, ...) reach
 * the IPC layer as the typed GitError, with the kind and hint the agent
 * classified, so the renderer can branch on them (non-fast-forward retry,
 * auth recovery) instead of receiving an unexpected error.
 */
import { describe, expect, it, mock } from "bun:test";
import { AgentGitExecutor } from "../../../../src/main/features/git/bridge/agent-executor";
import { GitError } from "../../../../src/main/features/git/domain/error";

function agentError(message: string, fields: { code?: string; data?: unknown }): Error {
  return Object.assign(new Error(message), fields);
}

function makeExecutor(failure: Error) {
  const provider = {
    kind: "local" as const,
    callAgentMethod: mock(async (method: string) => {
      if (method === "git.cancel") return undefined;
      throw failure;
    }),
    onAgentEvent: () => () => {},
    onAgentLifecycle: () => () => {},
    isAgentAvailable: () => true,
  };
  return new AgentGitExecutor(provider);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("AgentGitExecutor agent failures", () => {
  it("rethrows a classified push failure as GitError with its kind and hint", async () => {
    const executor = makeExecutor(
      agentError("! [rejected] main -> main (non-fast-forward)", {
        code: "server.request-failed",
        data: { errorKind: "non-fast-forward", errorHint: { kind: "pull-then-retry" } },
      }),
    );

    const error = await rejection(executor.push({ cwd: "/repo" }));
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({
      kind: "non-fast-forward",
      message: "! [rejected] main -> main (non-fast-forward)",
      hint: { kind: "pull-then-retry" },
    });
  });

  it("gives a request failure without kind data the unknown kind", async () => {
    // An agent that predates the error data, or a failure that is no git exit.
    const executor = makeExecutor(
      agentError("git askpass helper unavailable", { code: "server.request-failed" }),
    );

    const error = await rejection(executor.tagCreate({ cwd: "/repo", name: "v1" }));
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ kind: "unknown", message: "git askpass helper unavailable" });
  });

  it("passes transport failures through unchanged", async () => {
    const transport = agentError("SSH transport failed", { code: "ssh.unknown" });
    const executor = makeExecutor(transport);

    expect(await rejection(executor.stashList({ cwd: "/repo" }))).toBe(transport);
  });
});
