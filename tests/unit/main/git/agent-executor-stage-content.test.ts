/**
 * Staging part of a file reaches the agent as one git.stageContent call that
 * carries the whole new index version; the agent writes the blob and index
 * entry (internal/git/stage_content.go).
 */
import { describe, expect, it, mock } from "bun:test";
import { AgentGitExecutor } from "../../../../src/main/features/git/bridge/agent-executor";
import { GitError } from "../../../../src/main/features/git/domain/error";

function makeExecutor(callAgentMethod: (method: string, params: unknown) => Promise<unknown>) {
  const provider = {
    kind: "local" as const,
    callAgentMethod: mock(callAgentMethod),
    onAgentEvent: () => () => {},
    onAgentLifecycle: () => () => {},
    isAgentAvailable: () => true,
  };
  return { executor: new AgentGitExecutor(provider), provider };
}

describe("AgentGitExecutor.stageContent", () => {
  it("sends the path and full content to git.stageContent", async () => {
    const { executor, provider } = makeExecutor(async () => null);

    await executor.stageContent({ cwd: "/repo", relPath: "src/a.ts", content: "a\n\nb" });

    expect(provider.callAgentMethod).toHaveBeenCalledTimes(1);
    expect(provider.callAgentMethod.mock.calls[0]).toEqual([
      "git.stageContent",
      { cwd: "/repo", relPath: "src/a.ts", content: "a\n\nb" },
    ]);
  });

  it("rethrows an agent failure as GitError", async () => {
    const { executor } = makeExecutor(async () => {
      throw Object.assign(new Error("Only regular files can be staged in part"), {
        code: "server.request-failed",
      });
    });

    const error = await executor.stageContent({ cwd: "/repo", relPath: "link", content: "x" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ message: "Only regular files can be staged in part" });
  });
});
