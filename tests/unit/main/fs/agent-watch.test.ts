import { describe, expect, it, mock } from "bun:test";
import { AgentFsWatcher } from "../../../../src/main/features/fs/bridge/agent-watch";

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
  };
  const manager = {
    getFs: mock(async (_workspaceId: string) => provider),
  };
  const broadcasts: Array<{ channel: string; event: string; args: unknown }> = [];
  const watcher = new AgentFsWatcher(manager as never, (channel, event, args) => {
    broadcasts.push({ channel, event, args });
  });
  return { watcher, provider, listeners, broadcasts };
}

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
});
