import { describe, expect, it, mock } from "bun:test";
import { AgentGitWatcher } from "../../../../src/main/features/git/bridge/agent-watch";

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174020";

function makeProvider() {
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
  const emitChanged = (payload: unknown) => {
    for (const callback of Array.from(listeners.get("git.changed") ?? [])) callback(payload);
  };
  return { provider, listeners, emitLifecycle, emitChanged };
}

function makeFixture() {
  const first = makeProvider();
  let current = first.provider;
  const providerReadyListeners = new Set<(workspaceId: string, provider: unknown) => void>();
  const manager = {
    requireContext: () => ({ fs: current }),
    onProviderReady: (listener: (workspaceId: string, provider: unknown) => void) => {
      providerReadyListeners.add(listener);
      return () => providerReadyListeners.delete(listener);
    },
  };
  /** Simulates the manager booting a replacement agent after the channel died. */
  const reboot = () => {
    const next = makeProvider();
    current = next.provider;
    for (const listener of Array.from(providerReadyListeners))
      listener(WORKSPACE_ID, next.provider);
    return next;
  };
  const dirty = mock((_workspaceId: string) => {});
  const watcher = new AgentGitWatcher(manager as never, dirty);
  return {
    watcher,
    provider: first.provider,
    listeners: first.listeners,
    dirty,
    emitLifecycle: first.emitLifecycle,
    emitChanged: first.emitChanged,
    reboot,
  };
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

  // Regression: repo detection does not run again after the agent is
  // replaced, so the .git watch stayed on the dead provider and status went
  // stale until the app restarted.
  it("re-registers the .git watch on a rebooted agent and refreshes status", async () => {
    const fixture = makeFixture();
    await fixture.watcher.watch(WORKSPACE_ID, "/repo/.git");

    const next = fixture.reboot();
    await settle();

    expect(next.provider.callAgentMethod.mock.calls).toEqual([
      ["git.watch", { gitDir: "/repo/.git" }],
    ]);
    expect(fixture.provider.callAgentMethod).not.toHaveBeenCalledWith("git.unwatch", {
      gitDir: "/repo/.git",
    });
    expect(fixture.dirty).toHaveBeenCalledTimes(1);

    fixture.dirty.mockClear();
    fixture.emitChanged({ gitDir: "/repo/.git" });
    expect(fixture.dirty).not.toHaveBeenCalled();
    next.emitChanged({ gitDir: "/repo/.git" });
    expect(fixture.dirty).toHaveBeenCalledTimes(1);
  });

  it("ignores a provider boot for a workspace without a .git watch", async () => {
    const fixture = makeFixture();
    const next = fixture.reboot();
    await settle();

    expect(next.provider.callAgentMethod).not.toHaveBeenCalled();
    expect(fixture.dirty).not.toHaveBeenCalled();
  });
});
