import { describe, expect, it, mock } from "bun:test";
import { AgentFsWatcher } from "../../../../src/main/features/fs/bridge/agent-watch";

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
  };
  const emitLifecycle = (event: { type: string }) => {
    for (const callback of Array.from(lifecycleListeners)) callback(event);
  };
  const manager = {
    getFs: mock(async (_workspaceId: string) => provider),
  };
  const broadcasts: Array<{ channel: string; event: string; args: unknown }> = [];
  const watcher = new AgentFsWatcher(manager as never, (channel, event, args) => {
    broadcasts.push({ channel, event, args });
  });
  return { watcher, provider, listeners, broadcasts, emitLifecycle };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("AgentFsWatcher", () => {
  it("delegates watch calls to the agent and forwards fs.changed with workspaceId", async () => {
    const { watcher, provider, listeners, broadcasts } = makeFixture();

    await watcher.watch(WORKSPACE_ID, "src");
    for (const callback of listeners.get("fs.changed") ?? []) {
      callback({ changes: [{ relPath: "src/a.ts", kind: "modified" }] });
    }

    expect(provider.callAgentMethod).toHaveBeenCalledWith("fs.watch", { relPath: "src" });
    expect(broadcasts).toEqual([
      {
        channel: "fs",
        event: "changed",
        args: {
          workspaceId: WORKSPACE_ID,
          changes: [{ relPath: "src/a.ts", kind: "modified" }],
        },
      },
    ]);
  });

  it("removes the event subscription after the last unwatch", async () => {
    const { watcher, listeners, broadcasts } = makeFixture();

    await watcher.watch(WORKSPACE_ID, ".");
    await watcher.unwatch(WORKSPACE_ID, ".");
    for (const callback of listeners.get("fs.changed") ?? []) {
      callback({ changes: [{ relPath: "a.ts", kind: "modified" }] });
    }

    expect(broadcasts).toEqual([]);
  });

  // Regression: a respawned agent process starts with zero fs watches, so the
  // watcher must replay every registered relPath when the channel reports a
  // successful reconnect handshake (`ready` lifecycle event).
  it("replays all watched relPaths on the channel ready lifecycle event", async () => {
    const { watcher, provider, emitLifecycle } = makeFixture();

    await watcher.watch(WORKSPACE_ID, "");
    await watcher.watch(WORKSPACE_ID, "src");
    provider.callAgentMethod.mockClear();

    emitLifecycle({ type: "ready" });
    await settle();

    const calls = provider.callAgentMethod.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual(["fs.watch", { relPath: "" }]);
    expect(calls).toContainEqual(["fs.watch", { relPath: "src" }]);
  });

  it("does not replay on non-ready lifecycle events", async () => {
    const { watcher, provider, emitLifecycle } = makeFixture();

    await watcher.watch(WORKSPACE_ID, "src");
    provider.callAgentMethod.mockClear();

    emitLifecycle({ type: "degraded" });
    emitLifecycle({ type: "reconnecting" });
    await settle();

    expect(provider.callAgentMethod).not.toHaveBeenCalled();
  });

  it("does not replay unwatched relPaths", async () => {
    const { watcher, provider, emitLifecycle } = makeFixture();

    await watcher.watch(WORKSPACE_ID, "src");
    await watcher.watch(WORKSPACE_ID, "docs");
    await watcher.unwatch(WORKSPACE_ID, "docs");
    provider.callAgentMethod.mockClear();

    emitLifecycle({ type: "ready" });
    await settle();

    expect(provider.callAgentMethod.mock.calls).toEqual([["fs.watch", { relPath: "src" }]]);
  });
});
