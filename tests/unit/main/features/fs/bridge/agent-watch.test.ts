import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { AgentFsWatcher } from "../../../../../../src/main/features/fs/bridge/agent-watch";

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
  };
  const emitLifecycle = (event: { type: string }) => {
    for (const callback of Array.from(lifecycleListeners)) callback(event);
  };
  const emitChanged = (payload: unknown) => {
    for (const callback of Array.from(listeners.get("fs.changed") ?? [])) callback(payload);
  };
  return { provider, listeners, emitLifecycle, emitChanged };
}

function makeFixture() {
  const first = makeProvider();
  let current = first.provider;
  const providerReadyListeners = new Set<(workspaceId: string, provider: unknown) => void>();
  const manager = {
    getFs: mock(async (_workspaceId: string) => current),
    onProviderReady: (listener: (workspaceId: string, provider: unknown) => void) => {
      providerReadyListeners.add(listener);
      return () => providerReadyListeners.delete(listener);
    },
  };
  const reboot = () => {
    const next = makeProvider();
    current = next.provider;
    for (const listener of Array.from(providerReadyListeners))
      listener(WORKSPACE_ID, next.provider);
    return next;
  };
  const swapSilently = () => {
    const next = makeProvider();
    current = next.provider;
    return next;
  };
  const broadcasts: Array<{ channel: string; event: string; args: unknown }> = [];
  const watcher = new AgentFsWatcher(manager as never, (channel, event, args) => {
    broadcasts.push({ channel, event, args });
  });
  return {
    watcher,
    provider: first.provider,
    listeners: first.listeners,
    broadcasts,
    emitLifecycle: first.emitLifecycle,
    emitChanged: first.emitChanged,
    reboot,
    swapSilently,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function panelWindow() {
  const events = new EventEmitter();
  const isDestroyed = mock(() => false);
  const owner = Object.assign(events, { isDestroyed }) as unknown as WebContents;
  return {
    owner,
    close() {
      isDestroyed.mockReturnValue(true);
      events.emit("destroyed");
    },
  };
}

describe("AgentFsWatcher", () => {
  it("keeps a collapsed directory watched by a panel and preserves a tree watch when the panel closes", async () => {
    const { watcher, provider, emitChanged, broadcasts } = makeFixture();
    const { owner } = panelWindow();
    await watcher.watch(WORKSPACE_ID, "collapsed", owner);
    emitChanged({ changes: [{ relPath: "collapsed/plan.md", kind: "modified" }] });
    expect(broadcasts).toHaveLength(1);

    await watcher.watch(WORKSPACE_ID, "collapsed");
    await watcher.unwatch(WORKSPACE_ID, "collapsed");
    expect(provider.callAgentMethod.mock.calls.map(([method]) => method)).toEqual([
      "fs.watch",
      "fs.watch",
    ]);

    await watcher.watch(WORKSPACE_ID, "collapsed");
    await watcher.unwatch(WORKSPACE_ID, "collapsed", owner);
    expect(provider.callAgentMethod.mock.calls.map(([method]) => method)).toEqual([
      "fs.watch",
      "fs.watch",
      "fs.watch",
    ]);
    await watcher.unwatch(WORKSPACE_ID, "collapsed");
    expect(provider.callAgentMethod.mock.lastCall).toEqual([
      "fs.unwatch",
      { relPath: "collapsed" },
    ]);
  });

  it("releases a destroyed renderer's panel watches without removing another window's watches", async () => {
    const { watcher, provider } = makeFixture();
    const first = panelWindow();
    const second = panelWindow();
    await watcher.watch(WORKSPACE_ID, "shared", first.owner);
    await watcher.watch(WORKSPACE_ID, "shared", second.owner);
    await watcher.watch(WORKSPACE_ID, "first-only", first.owner);
    provider.callAgentMethod.mockClear();

    first.close();
    await settle();
    expect(provider.callAgentMethod.mock.calls).toEqual([
      ["fs.unwatch", { relPath: "first-only" }],
    ]);
    second.close();
    await settle();
    expect(provider.callAgentMethod.mock.lastCall).toEqual(["fs.unwatch", { relPath: "shared" }]);
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

  it("keeps receiving changes when the last active watch is removed during another registration", async () => {
    const { watcher, provider, emitChanged, broadcasts } = makeFixture();
    await watcher.watch(WORKSPACE_ID, "src");
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<object>();
    provider.callAgentMethod.mockImplementationOnce(() => {
      started.resolve();
      return reply.promise;
    });
    const watch = watcher.watch(WORKSPACE_ID, "docs");
    await started.promise;
    await watcher.unwatch(WORKSPACE_ID, "src");
    reply.resolve({});
    await watch;

    emitChanged({ changes: [{ relPath: "docs/new.md", kind: "added" }] });
    expect(broadcasts).toHaveLength(1);
  });

  it("orders collapse behind the same path's pending watch", async () => {
    const { watcher, provider, emitLifecycle } = makeFixture();
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<object>();
    provider.callAgentMethod.mockImplementationOnce(() => {
      started.resolve();
      return reply.promise;
    });
    const watch = watcher.watch(WORKSPACE_ID, "src");
    await started.promise;
    const unwatch = watcher.unwatch(WORKSPACE_ID, "src");
    await Promise.resolve();
    await Promise.resolve();
    expect(provider.callAgentMethod.mock.calls).toEqual([["fs.watch", { relPath: "src" }]]);
    reply.resolve({});
    await Promise.all([watch, unwatch]);

    emitLifecycle({ type: "ready" });
    expect(provider.callAgentMethod.mock.calls).toEqual([
      ["fs.watch", { relPath: "src" }],
      ["fs.unwatch", { relPath: "src" }],
    ]);
  });

  it("replays a pending path on replacement and cleans up its late registration", async () => {
    const fixture = makeFixture();
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<object>();
    fixture.provider.callAgentMethod.mockImplementationOnce(() => {
      started.resolve();
      return reply.promise;
    });
    const watch = fixture.watcher.watch(WORKSPACE_ID, "src");
    await started.promise;
    const next = fixture.reboot();
    reply.resolve({});
    await watch;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fixture.provider.callAgentMethod.mock.calls).toEqual([
      ["fs.watch", { relPath: "src" }],
      ["fs.unwatch", { relPath: "src" }],
    ]);
    expect(next.provider.callAgentMethod.mock.calls).toEqual([["fs.watch", { relPath: "src" }]]);
  });

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

  it("moves watches to a rebooted agent when the manager reports a new provider", async () => {
    const fixture = makeFixture();
    await fixture.watcher.watch(WORKSPACE_ID, "");
    await fixture.watcher.watch(WORKSPACE_ID, "src");
    fixture.broadcasts.length = 0;

    const next = fixture.reboot();
    await settle();

    expect(next.provider.callAgentMethod.mock.calls).toEqual([
      ["fs.watch", { relPath: "" }],
      ["fs.watch", { relPath: "src" }],
    ]);
    expect(fixture.broadcasts).toEqual([
      {
        channel: "fs",
        event: "changed",
        args: {
          workspaceId: WORKSPACE_ID,
          changes: [
            { relPath: "", kind: "added" },
            { relPath: "src", kind: "added" },
          ],
        },
      },
    ]);

    fixture.broadcasts.length = 0;
    fixture.emitChanged({ changes: [{ relPath: "src/old.ts", kind: "modified" }] });
    next.emitChanged({ changes: [{ relPath: "src/new.ts", kind: "modified" }] });
    expect(fixture.broadcasts).toEqual([
      {
        channel: "fs",
        event: "changed",
        args: { workspaceId: WORKSPACE_ID, changes: [{ relPath: "src/new.ts", kind: "modified" }] },
      },
    ]);
  });

  it("moves watches over when a watch call is the first to see the new provider", async () => {
    const fixture = makeFixture();
    await fixture.watcher.watch(WORKSPACE_ID, "src");

    const next = fixture.swapSilently();
    await fixture.watcher.watch(WORKSPACE_ID, "docs");

    expect(next.provider.callAgentMethod.mock.calls).toEqual([
      ["fs.watch", { relPath: "src" }],
      ["fs.watch", { relPath: "docs" }],
    ]);
  });

  it("ignores a provider boot for a workspace it is not watching", async () => {
    const fixture = makeFixture();
    const next = fixture.reboot();
    await settle();

    expect(next.provider.callAgentMethod).not.toHaveBeenCalled();
    expect(fixture.broadcasts).toEqual([]);
  });
});
