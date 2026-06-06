import { describe, expect, it, mock } from "bun:test";
import { AgentGitWatcher } from "../../../../src/main/features/git/bridge/agent-watch";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174020";

function makeFixture() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const lifecycleListeners = new Set<(event: { type: string }) => void>();
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
    onAgentLifecycle: (callback: (event: { type: string }) => void) => {
      lifecycleListeners.add(callback);
      return () => lifecycleListeners.delete(callback);
    },
    isAgentAvailable: () => true,
  };
  const emitLifecycle = (event: { type: string }) => {
    for (const callback of Array.from(lifecycleListeners)) callback(event);
  };
  const manager = {
    requireContext: () => ({ fs: provider }),
  };
  const dirty = mock((_workspaceId: string) => {});
  const watcher = new AgentGitWatcher(manager as never, dirty);
  return { watcher, provider, listeners, dirty, emitLifecycle };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

  // Regression: a respawned agent process starts without the .git watcher, so
  // the registration must be replayed when the channel reports a successful
  // reconnect handshake (`ready` lifecycle event).
  it("replays git.watch on the channel ready lifecycle event", async () => {
    const { watcher, provider, emitLifecycle } = makeFixture();

    await watcher.watch(WORKSPACE_ID, "/repo/.git");
    provider.callAgentMethod.mockClear();

    emitLifecycle({ type: "ready" });
    await settle();

    expect(provider.callAgentMethod.mock.calls).toEqual([
      ["git.watch", { gitDir: "/repo/.git" }],
    ]);
  });

  it("does not replay on non-ready lifecycle events or after dispose", async () => {
    const { watcher, provider, emitLifecycle } = makeFixture();

    await watcher.watch(WORKSPACE_ID, "/repo/.git");
    provider.callAgentMethod.mockClear();

    emitLifecycle({ type: "degraded" });
    await settle();
    expect(provider.callAgentMethod).not.toHaveBeenCalled();

    watcher.disposeWorkspace(WORKSPACE_ID);
    provider.callAgentMethod.mockClear();
    emitLifecycle({ type: "ready" });
    await settle();
    expect(provider.callAgentMethod).not.toHaveBeenCalled();
  });
});
