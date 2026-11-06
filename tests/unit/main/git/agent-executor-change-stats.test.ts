/**
 * A worktree's lines changed and its commits ahead of and behind a base come
 * from the agent's git.changeStats (internal/git/change_stats.go).
 */
import { describe, expect, it, mock } from "bun:test";
import { AgentGitExecutor } from "../../../../src/main/features/git/bridge/agent-executor";

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

describe("AgentGitExecutor.changeStats", () => {
  it("asks git.changeStats for the worktree and its base", async () => {
    const stats = {
      files: [
        { path: "src/a.ts", added: 3, deleted: 1 },
        { path: "logo.png", added: 0, deleted: 0, binary: true },
      ],
      ahead: 2,
      behind: 0,
    };
    const { executor, provider } = makeExecutor(async () => stats);

    const result = await executor.changeStats({ cwd: "/repo", base: "main" });

    expect(provider.callAgentMethod.mock.calls[0]).toEqual([
      "git.changeStats",
      { cwd: "/repo", base: "main" },
    ]);
    expect(result).toEqual(stats);
  });

  it("leaves the base out when there is none", async () => {
    const { executor, provider } = makeExecutor(async () => ({ files: [] }));

    const result = await executor.changeStats({ cwd: "/repo" });

    expect(provider.callAgentMethod.mock.calls[0]).toEqual(["git.changeStats", { cwd: "/repo" }]);
    expect(result).toEqual({ files: [] });
  });
});
