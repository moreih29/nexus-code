import { Database } from "bun:sqlite";
import { describe, expect, jest, mock, spyOn, test } from "bun:test";
import os from "node:os";
import path from "node:path";

mock.module("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

const { GlobalStorage } = await import("../../../../../src/main/infra/storage/global-storage");
const { WorkspaceStorage } = await import(
  "../../../../../src/main/infra/storage/workspace-storage"
);
const { openTestState } = await import("../../../../helpers/test-state");
const { WorkspaceManager } = await import("../../../../../src/main/features/workspace/manager");
const { ChatHost } = await import("../../../../../src/main/features/chat/host");
const { startAgentPtyHost } = await import("../../../../../src/main/features/pty/agent-host");

type ChannelLifecycleCallback = (event: { type: string }) => void;

class StubChannel {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private lifecycleListeners: Set<ChannelLifecycleCallback> = new Set();
  disposed = false;
  hookInfo = mock(async (): Promise<unknown> => ({ socketPath: "/tmp/hook.sock", token: "tok" }));
  readonly spawns: Array<{ env: Record<string, string> }> = [];
  onChatClose?: (params: unknown, options?: { timeoutMs?: number }) => Promise<void>;

  constructor() {
    this.ready = new Promise<void>((res) => {
      this.resolveReady = res;
    });
  }

  async call(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
    if (method === "hook.getInfo") return this.hookInfo();
    if (method === "lsp.findBinary") return { path: "/stub/model" };
    if (method === "chat.exec") return { code: 0, stdout: "2.1.400" };
    if (method === "chat.close") return this.onChatClose?.(params, options);
    if (method === "chat.start" || method === "pty.spawn") {
      this.spawns.push(params as (typeof this.spawns)[number]);
      return { pid: 1 };
    }
    return {};
  }

  fire(_method: string, _params?: unknown): void {}

  private eventListeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, cb: (payload: unknown) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? new Set();
    listeners.add(cb);
    this.eventListeners.set(event, listeners);
    return () => listeners.delete(cb);
  }

  emit(event: string, payload: unknown): void {
    for (const cb of [...(this.eventListeners.get(event) ?? [])]) cb(payload);
  }

  onLifecycle(cb: ChannelLifecycleCallback): () => void {
    this.lifecycleListeners.add(cb);
    return () => this.lifecycleListeners.delete(cb);
  }

  emitLifecycle(event: { type: string; hadEpoch?: boolean }): void {
    for (const cb of [...this.lifecycleListeners]) cb(event);
  }

  resolveChannel(): void {
    this.resolveReady();
  }

  dispose(): void {
    this.disposed = true;
  }
}

function makeHarness() {
  const removeShimDirMock = mock((_workspaceId: string) => Promise.resolve());
  const writeShimFilesMock = mock((_workspaceId: string) =>
    Promise.resolve({
      dir: "/stub/shim",
      zshrc: "/stub/shim/.zshrc",
      zshenv: "/stub/shim/.zshenv",
      bashrc: "/stub/shim/bashrc",
    }),
  );

  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);
  const wsBaseDir = path.join(os.tmpdir(), `nexus-lc-degraded-${Date.now()}`);
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, () => new Database(":memory:"));
  const stateService = openTestState(
    path.join(os.tmpdir(), `nexus-lc-degraded-state-${Date.now()}.json`),
  );
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {});

  const channels: StubChannel[] = [];
  const createChannel = () => {
    const channel = new StubChannel();
    channels.push(channel);
    if (channels.length > 1) {
      channel.hookInfo.mockResolvedValue({ socketPath: "/tmp/new-provider.sock", token: "new" });
    }
    channel.resolveChannel();
    return channel;
  };
  const bootstrap = async () => ({
    remoteCommand: "/stub/agent --dial sock",
    remoteHome: "/stub",
    remoteBinDir: "/stub/bin",
    platform: { os: "linux", arch: "amd64" } as const,
    uploaded: false,
  });
  const manager = new WorkspaceManager(
    globalStorage,
    workspaceStorage,
    stateService,
    broadcast,
    createChannel as never,
    bootstrap,
    createChannel as never,
    () => ({ bin: "/stub/agent", args: [] }),
    undefined as never,
    writeShimFilesMock,
    removeShimDirMock,
    { bootstrap, createChannel } as never,
  );

  return { manager, globalDb, channels, removeShimDirMock, writeShimFilesMock };
}

async function bootLocalWorkspace(harness: ReturnType<typeof makeHarness>) {
  const meta = harness.manager.create({
    rootPath: path.join(os.tmpdir(), `lc-degraded-${Math.random().toString(36).slice(2)}`),
    name: "lc-degraded",
  });
  await harness.manager.getAgentChannel(meta.id);
  return meta;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("workspace removal keeps its local agent alive until restored chats are closed", async () => {
  const harness = makeHarness();
  const { manager, channels, globalDb } = harness;
  const host = new ChatHost({
    workspaceManager: manager,
    broadcast: () => {},
    knownChatTabs: () => ["restored"],
  });
  manager.setChatSessionCloser((id, channel) => host.closeWorkspace(id, channel));
  try {
    const { id } = await bootLocalWorkspace(harness);
    const closing = Promise.withResolvers<unknown>();
    const closed = Promise.withResolvers<void>();
    const [channel] = channels;
    channel.onChatClose = (params) => {
      closing.resolve(params);
      return closed.promise;
    };
    const removing = manager.remove(id);
    expect(await closing.promise).toEqual({ workspaceId: id, tabId: "restored" });
    expect(channel.disposed).toBe(false);
    closed.resolve();
    await removing;
    expect(channel.disposed).toBe(true);
    expect(manager.list()).toEqual([]);
  } finally {
    host.dispose();
    globalDb.close();
  }
});

test("workspace removal finishes within five seconds when chat.close never replies", async () => {
  const harness = makeHarness();
  const { manager, channels, globalDb } = harness;
  const host = new ChatHost({ workspaceManager: manager, broadcast: () => {} });
  manager.setChatSessionCloser((id, channel) => host.closeWorkspace(id, channel));
  const response = Promise.withResolvers<void>();
  let removing: Promise<void> | undefined;
  try {
    const { id } = await bootLocalWorkspace(harness);
    spyOn(manager, "getWrapperBinDir").mockReturnValue("/stub/bin");
    spyOn(manager, "getWrapperAgentBin").mockReturnValue("/stub/bin/agent");
    spyOn(manager, "getWrapperShimDir").mockReturnValue("/stub/shim");
    await host.startCodex(id, "open-chat", "/project", {});
    const task = manager.create({
      rootPath: "/stub/task",
      name: "task",
      task: { parentId: id, branch: "task", worktreePath: "/stub/task" },
    });
    await host.startCodex(task.id, "task-chat", "/stub/task", {});
    const started = Promise.withResolvers<void>();
    const timeouts: (number | undefined)[] = [];
    for (const channel of channels) {
      channel.onChatClose = (_params, options) => {
        timeouts.push(options?.timeoutMs);
        started.resolve();
        return response.promise;
      };
    }
    jest.useFakeTimers();
    removing = manager.remove(id);
    await started.promise;
    jest.advanceTimersByTime(5000);
    jest.useRealTimers();
    const checkpoint = new Promise<string>((resolve) => setImmediate(() => resolve("pending")));
    expect(await Promise.race([removing.then(() => "removed"), checkpoint])).toBe("removed");
    expect(timeouts).toEqual([5000, 5000]);
    expect(channels.every((channel) => channel.disposed)).toBe(true);
    expect(manager.list()).toEqual([]);
    const tracking = host as unknown as {
      tabIntents: ReadonlyMap<string, unknown>;
      closingTabs: ReadonlyMap<string, unknown>;
    };
    expect(tracking.tabIntents.size).toBe(0);
    expect(tracking.closingTabs.size).toBe(0);
  } finally {
    jest.useRealTimers();
    response.resolve();
    await removing;
    host.dispose();
    globalDb.close();
  }
});

for (const available of [true, false]) {
  test(`local reconnect waits for refreshed hooks before resync and spawn (${available ? "available" : "unavailable"})`, async () => {
    const harness = makeHarness();
    const { manager, channels, globalDb } = harness;
    const wrapperDir = spyOn(manager, "getWrapperBinDir").mockReturnValue("/stub/wrappers");
    const resynced = Promise.withResolvers<void>();
    const events: string[] = [];
    const host = new ChatHost({
      workspaceManager: manager,
      broadcast: (event) => {
        events.push(event);
        if (event === "resync") resynced.resolve();
      },
    });
    try {
      const { id } = await bootLocalWorkspace(harness);
      await host.startCodex(id, "before", "/project", {});
      const [channel] = channels;
      const answer = Promise.withResolvers<unknown>();
      channel.hookInfo.mockImplementation(() => answer.promise);
      channel.emitLifecycle({ type: "reconnecting" });
      channel.emitLifecycle({ type: "ready" });
      expect(events).toEqual(["held"]);
      expect(channel.hookInfo).toHaveBeenCalledTimes(2);
      const starting = Promise.all([
        host.startCodex(id, "codex", "/project", {}),
        host.start(id, "claude", "/project", {}),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(channel.spawns).toHaveLength(1);
      expect(manager.getHookInfo(id)).toBeNull();
      expect(events).toEqual(["held"]);
      const socketPath = "/tmp/replacement.sock";
      if (available) answer.resolve({ socketPath, token: "replacement-token" });
      else answer.reject(Object.assign(new Error("unavailable"), { code: "server.unavailable" }));
      const [results] = await Promise.all([starting, resynced.promise]);
      expect(results.map((result) => result.ok)).toEqual([true, true]);
      expect(channels).toHaveLength(1);
      expect(channel.spawns).toHaveLength(3);
      for (const { env } of channel.spawns.slice(1)) {
        expect(env.NEXUS_AGENT_SOCKET).toBe(available ? socketPath : undefined);
        expect(env.NEXUS_HOOK_TOKEN).toBe(available ? "replacement-token" : undefined);
      }
      expect(events).toEqual(["held", "resync"]);
    } finally {
      wrapperDir.mockRestore();
      host.dispose();
      globalDb.close();
    }
  });
}

test("a superseded local hook reply cannot release chat resync", async () => {
  const harness = makeHarness();
  const { manager, channels, globalDb } = harness;
  const resynced = Promise.withResolvers<void>();
  const events: string[] = [];
  const host = new ChatHost({
    workspaceManager: manager,
    broadcast: (event) => {
      events.push(event);
      if (event === "resync") resynced.resolve();
    },
  });
  try {
    const { id } = await bootLocalWorkspace(harness);
    await host.startCodex(id, "tab", "/project", {});
    const [channel] = channels;
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    channel.hookInfo.mockImplementationOnce(() => first.promise);
    channel.hookInfo.mockImplementationOnce(() => second.promise);
    channel.emitLifecycle({ type: "reconnecting" });
    channel.emitLifecycle({ type: "ready" });
    channel.emitLifecycle({ type: "reconnecting" });
    channel.emitLifecycle({ type: "ready" });
    first.resolve({ socketPath: "/tmp/stale.sock", token: "stale" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["held", "held"]);
    expect(manager.getHookInfo(id)).toBeNull();

    const current = { socketPath: "/tmp/current.sock", token: "current" };
    second.resolve(current);
    await resynced.promise;
    expect(events).toEqual(["held", "held", "resync"]);
    expect(manager.getHookInfo(id)).toEqual(current);
  } finally {
    host.dispose();
    globalDb.close();
  }
});

test("PTY spawn waits for the local replacement's hook endpoint", async () => {
  const harness = makeHarness();
  const { manager, channels, globalDb } = harness;
  const host = startAgentPtyHost(manager);
  try {
    const { id } = await bootLocalWorkspace(harness);
    const [channel] = channels;
    const answer = Promise.withResolvers<unknown>();
    channel.hookInfo.mockImplementation(() => answer.promise);
    channel.emitLifecycle({ type: "reconnecting", hadEpoch: false });
    channel.emitLifecycle({ type: "ready" });
    const spawn = host.call("spawn", {
      workspaceId: id,
      tabId: "terminal",
      cwd: "/project",
      cols: 80,
      rows: 24,
      env: { NEXUS_IN_APP: "1", NEXUS_WRAPPER_SELF_DIR: "/stub/bin" },
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(channel.spawns).toHaveLength(0);
    } finally {
      answer.resolve({ socketPath: "/tmp/new-terminal.sock", token: "new-terminal" });
      await spawn;
    }
    expect(channel.spawns[0]?.env).toMatchObject({
      NEXUS_AGENT_SOCKET: "/tmp/new-terminal.sock",
      NEXUS_HOOK_TOKEN: "new-terminal",
    });
  } finally {
    host.dispose();
    globalDb.close();
  }
});

test("hooks from a local agent that restarted on the same channel still reach the app", async () => {
  const harness = makeHarness();
  const { manager, channels, globalDb } = harness;
  const host = startAgentPtyHost(manager);
  try {
    const { id } = await bootLocalWorkspace(harness);
    await settle();
    const [channel] = channels;
    const hooks: unknown[] = [];
    host.on("claude.hook", (payload) => hooks.push(payload));
    channel.hookInfo.mockResolvedValue({ socketPath: "/tmp/restarted.sock", token: "restarted" });
    channel.emitLifecycle({ type: "reconnecting", hadEpoch: false });
    channel.emitLifecycle({ type: "ready" });
    await settle();

    const start = {
      hookId: "h1",
      workspaceId: id,
      tabId: "claude-tab",
      subcommand: "print-start",
      payload: { run_id: "print-1" },
    };
    channel.emit("claude.hook", start);

    expect(hooks).toEqual([start]);
    expect(manager.getHookInfo(id)).toMatchObject({ socketPath: "/tmp/restarted.sock" });
  } finally {
    host.dispose();
    globalDb.close();
  }
});

for (const kind of ["ssh", "wsl"] as const) {
  test(`${kind} reattach keeps hooks and daemon replacement loads them on a new provider`, async () => {
    const { manager, channels, globalDb } = makeHarness();
    const location =
      kind === "ssh"
        ? {
            kind,
            host: "example.test",
            user: "test",
            remotePath: "/project",
            authMode: "key-only" as const,
          }
        : { kind, distro: "Test", remotePath: "/project" };
    const context = manager.create({ location });
    const host = new ChatHost({ workspaceManager: manager, broadcast: () => {} });
    try {
      await host.startCodex(context.id, "before", "/project", {});
      const [first] = channels;
      first.emitLifecycle({ type: "reconnecting" });
      first.emitLifecycle({ type: "ready" });
      expect(first.hookInfo).toHaveBeenCalledTimes(1);
      expect(manager.getHookInfo(context.id)?.socketPath).toBe("/tmp/hook.sock");

      first.emitLifecycle({ type: "reconnecting" });
      first.emitLifecycle({ type: "held-then-expired" });
      expect(manager.getHookInfo(context.id)).toBeNull();
      await host.startCodex(context.id, "after", "/project", {});
      expect(first.disposed).toBe(true);
      expect(first.hookInfo).toHaveBeenCalledTimes(1);
      expect(channels).toHaveLength(2);
      expect(channels[1].hookInfo).toHaveBeenCalledTimes(1);
      expect(channels[1].spawns[0]?.env).toMatchObject({
        NEXUS_AGENT_SOCKET: "/tmp/new-provider.sock",
        NEXUS_HOOK_TOKEN: "new",
      });
    } finally {
      host.dispose();
      globalDb.close();
    }
  });
}

describe("handleLocalChannelLifecycle: health signals must not tear down the provider", () => {
  for (const type of ["degraded", "degraded-recovered", "ready"] as const) {
    test(`'${type}' keeps the provider and does not boot a second channel`, async () => {
      const harness = makeHarness();
      const meta = await bootLocalWorkspace(harness);
      expect(harness.channels).toHaveLength(1);

      harness.channels[0].emitLifecycle({ type });
      await settle();

      expect(harness.removeShimDirMock).not.toHaveBeenCalled();

      const again = await harness.manager.getAgentChannel(meta.id);
      expect(again).toBe(harness.channels[0] as never);
      expect(harness.channels).toHaveLength(1);

      harness.globalDb.close();
    });
  }

  for (const type of ["exit", "failure"] as const) {
    test(`'${type}' still tears the provider down and reboots on next request`, async () => {
      const harness = makeHarness();
      const meta = await bootLocalWorkspace(harness);
      expect(harness.channels).toHaveLength(1);

      harness.channels[0].emitLifecycle({ type });
      await settle();

      expect(harness.removeShimDirMock).toHaveBeenCalledTimes(1);
      expect(harness.removeShimDirMock.mock.calls[0][0]).toBe(meta.id);

      await harness.manager.getAgentChannel(meta.id);
      expect(harness.channels).toHaveLength(2);

      harness.globalDb.close();
    });
  }
});

test("a superseded local boot cannot replace the newly connected provider", async () => {
  const { manager, channels, writeShimFilesMock } = makeHarness();
  const { id } = manager.create({ rootPath: path.join(os.tmpdir(), "pending-local-boot") });
  const shim = Promise.withResolvers<Awaited<ReturnType<typeof writeShimFilesMock>>>();
  const writingShim = Promise.withResolvers<void>();
  writeShimFilesMock.mockImplementationOnce(() => {
    writingShim.resolve();
    return shim.promise;
  });
  const ready = mock(() => {});
  manager.onProviderReady(ready);

  try {
    const initial = manager.connect(id);
    await writingShim.promise;
    channels[0].emitLifecycle({ type: "exit" });
    const replacement = await manager.getAgentChannel(id);
    const provider = await manager.getFs(id);

    shim.resolve({ dir: "", zshrc: "", zshenv: "", bashrc: "" });
    await expect(initial).rejects.toMatchObject({ name: "AbortError" });
    expect(channels).toHaveLength(2);
    expect(channels[1].disposed).toBe(false);
    expect(await manager.getAgentChannel(id)).toBe(replacement);
    expect(await manager.getFs(id)).toBe(provider);
    expect(ready).toHaveBeenCalledTimes(1);
  } finally {
    manager.close();
  }
});

describe("onProviderReady", () => {
  test("fires on first boot and again with the replacement after a terminal exit", async () => {
    const harness = makeHarness();
    const ready: Array<{ workspaceId: string; provider: unknown }> = [];
    harness.manager.onProviderReady((workspaceId, provider) => {
      ready.push({ workspaceId, provider });
    });

    const meta = await bootLocalWorkspace(harness);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.workspaceId).toBe(meta.id);
    expect(ready[0]?.provider).toBe(harness.manager.requireContext(meta.id).fs);

    harness.channels[0].emitLifecycle({ type: "degraded" });
    await settle();
    expect(ready).toHaveLength(1);

    harness.channels[0].emitLifecycle({ type: "exit" });
    await settle();
    await harness.manager.getAgentChannel(meta.id);
    expect(ready).toHaveLength(2);
    expect(ready[1]?.provider).toBe(harness.manager.requireContext(meta.id).fs);
    expect(ready[1]?.provider).not.toBe(ready[0]?.provider);

    harness.globalDb.close();
  });
});
