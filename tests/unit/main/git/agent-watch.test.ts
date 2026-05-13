import { describe, expect, it, mock } from "bun:test";
import { AgentGitWatcher } from "../../../../src/main/bridge/git/agent-watch";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174020";

function makeFixture() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const provider = {
    kind: "local" as const,
    callAgentMethod: mock(async (_method: string, _params?: unknown) => ({})),
    onAgentEvent: (event: string, callback: (payload: unknown) => void) => {
      let callbacks = listeners.get(event);
      if (!callbacks) {
        callbacks = new Set();
        listeners.set(event, callbacks);
      }
      callbacks.add(callback);
      return () => callbacks?.delete(callback);
    },
    isAgentAvailable: () => true,
  };
  const manager = {
    requireContext: () => ({ fs: provider }),
  };
  const dirty = mock((_workspaceId: string) => {});
  const watcher = new AgentGitWatcher(manager as never, dirty);
  return { watcher, provider, listeners, dirty };
}

describe("AgentGitWatcher", () => {
  it("delegates git watch calls to the agent and forwards matching git.changed events", async () => {
    const { watcher, provider, listeners, dirty } = makeFixture();

    await watcher.watch(WORKSPACE_ID, "/repo/.git");
    for (const callback of listeners.get("git.changed") ?? []) {
      callback({ gitDir: "/repo/.git" });
      callback({ gitDir: "/other/.git" });
    }

    expect(provider.callAgentMethod).toHaveBeenCalledWith("git.watch", { gitDir: "/repo/.git" });
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("unsubscribes and asks the agent to unwatch when disposed", async () => {
    const { watcher, provider, listeners, dirty } = makeFixture();

    await watcher.watch(WORKSPACE_ID, "/repo/.git");
    watcher.disposeWorkspace(WORKSPACE_ID);
    for (const callback of listeners.get("git.changed") ?? []) {
      callback({ gitDir: "/repo/.git" });
    }

    expect(provider.callAgentMethod).toHaveBeenCalledWith("git.unwatch", { gitDir: "/repo/.git" });
    expect(dirty).not.toHaveBeenCalled();
  });
});
