import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../../../src/main/infra/storage/global-storage";
import { StateService } from "../../../../src/main/infra/storage/state-service";
import { WorkspaceStorage } from "../../../../src/main/infra/storage/workspace-storage";
import { GitRegistry } from "../../../../src/main/features/git/domain/registry";
import type { SshChannel, SshChannelLifecycleEvent } from "../../../../src/main/infra/agent/ssh/channel";
import type {
  BroadcastFn,
  WorkspaceLocalAgentCommandResolver,
  WorkspaceLocalChannelFactory,
  WorkspaceSshBootstrap,
  WorkspaceSshChannelFactory,
} from "../../../../src/main/features/workspace/manager";
import { WorkspaceManager } from "../../../../src/main/features/workspace/manager";
import type { SshErrorCode } from "../../../../src/shared/ssh/errors";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wsmgr-test-"));
}

function bunSqliteFactory(dbPath: string): Database {
  return new Database(dbPath);
}

function makeFixtures(tmpDir: string): {
  globalStorage: GlobalStorage;
  workspaceStorage: WorkspaceStorage;
  stateService: StateService;
  broadcastMock: ReturnType<typeof mock>;
} {
  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);
  const wsBaseDir = path.join(tmpDir, "workspaces");
  fs.mkdirSync(wsBaseDir, { recursive: true });
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, bunSqliteFactory);
  const stateService = new StateService(path.join(tmpDir, "state.json"));
  const broadcastMock = mock((_ch: string, _ev: string, _args: unknown) => {});
  return { globalStorage, workspaceStorage, stateService, broadcastMock };
}

function makeManager(
  globalStorage: GlobalStorage,
  workspaceStorage: WorkspaceStorage,
  stateService: StateService,
  broadcastFn: BroadcastFn,
  sshChannelFactory?: WorkspaceSshChannelFactory,
  sshBootstrap: WorkspaceSshBootstrap = fakeSshBootstrap,
  localChannelFactory: WorkspaceLocalChannelFactory = fakeReadyLocalChannelFactory(),
  localAgentCommandResolver: WorkspaceLocalAgentCommandResolver = fakeLocalAgentCommandResolver,
): WorkspaceManager {
  return new WorkspaceManager(
    globalStorage,
    workspaceStorage,
    stateService,
    broadcastFn,
    sshChannelFactory,
    sshBootstrap,
    localChannelFactory,
    localAgentCommandResolver,
  );
}

const fakeSshBootstrap = mock(async (options) => ({
  remoteCommand: `bash -lc 'exec ~/.nexus-code/bin/agent-0.1.0-linux-amd64 ${options.remotePath}'`,
  platform: { os: "linux" as const, arch: "amd64" as const },
  uploaded: false,
}));

const fakeLocalAgentCommandResolver: WorkspaceLocalAgentCommandResolver = () => ({
  binaryPath: "/tmp/fake-agent",
});

function fakeReadyLocalChannelFactory(): WorkspaceLocalChannelFactory {
  return (() => makeLifecycleChannel().channel) as WorkspaceLocalChannelFactory;
}

function workspaceMeta(
  meta: Pick<WorkspaceMeta, "id" | "name" | "location" | "rootPath">,
): WorkspaceMeta {
  return {
    id: meta.id,
    name: meta.name,
    location: meta.location,
    rootPath: meta.rootPath,
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function connectionStatuses(
  broadcastMock: ReturnType<typeof mock>,
): Array<{ workspaceId: string; status: string }> {
  return broadcastMock.mock.calls
    .filter(([channel, event]) => channel === "workspace" && event === "connectionChanged")
    .map(([, , args]) => args as { workspaceId: string; status: string });
}

function makeLifecycleChannel(ready: Promise<void> = Promise.resolve()): {
  channel: SshChannel;
  emitLifecycle: (event: SshChannelLifecycleEvent) => void;
} {
  let lifecycleCallback: ((event: SshChannelLifecycleEvent) => void) | null = null;
  const channel: SshChannel = {
    ready,
    call: mock(async () => []),
    on: mock(() => () => {}),
    onLifecycle: mock((callback: (event: SshChannelLifecycleEvent) => void) => {
      lifecycleCallback = callback;
      return () => {
        if (lifecycleCallback === callback) {
          lifecycleCallback = null;
        }
      };
    }),
    dispose: mock(() => {}),
  };

  return {
    channel,
    emitLifecycle(event) {
      lifecycleCallback?.(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceManager — create location metadata", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("normalizes legacy rootPath create args into a local location", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );
    const rootPath = path.join(tmpDir, "project");

    manager.init();
    const created = manager.create({ rootPath });

    expect(created.location).toEqual({ kind: "local", rootPath });
    expect(created.rootPath).toBe(rootPath);
    expect(created.name).toBe("project");

    manager.close();
  });

  it("creates ssh workspaces with alias-based default names", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();
    const created = manager.create({
      location: {
        kind: "ssh",
        host: "dev.example.com",
        remotePath: "/srv/repo",
        configAlias: "devbox",
      },
    });

    expect(created.name).toBe("devbox");
    expect(created.rootPath).toBe("/srv/repo");
    expect(created.location).toEqual({
      kind: "ssh",
      host: "dev.example.com",
      remotePath: "/srv/repo",
      configAlias: "devbox",
      authMode: "interactive",
    });

    manager.close();
  });

  it("creates ssh workspaces with host default names when no alias is present", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();
    const created = manager.create({
      location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/repo" },
    });

    expect(created.name).toBe("dev.example.com");
    expect(created.rootPath).toBe("/srv/repo");

    manager.close();
  });
});

describe("WorkspaceManager — restart simulation (persistence round-trip)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restores the same workspace on second init", async () => {
    const wsBaseDir = path.join(tmpDir, "workspaces");
    fs.mkdirSync(wsBaseDir, { recursive: true });
    const statePath = path.join(tmpDir, "state.json");
    // Use a file-backed bun:sqlite DB so data persists across instances.
    const globalDbPath = path.join(tmpDir, "state.db");

    function openFileGlobalStorage(dbPath: string): GlobalStorage {
      const db = new Database(dbPath);
      return new GlobalStorage(db);
    }

    // --- First boot ---
    const globalStorage1 = openFileGlobalStorage(globalDbPath);
    const ws1 = new WorkspaceStorage(wsBaseDir, bunSqliteFactory);
    const ss1 = new StateService(statePath);
    const bcast1 = mock((_c: string, _e: string, _a: unknown) => {});

    const mgr1 = makeManager(globalStorage1, ws1, ss1, bcast1 as BroadcastFn);
    await mgr1.init();
    const created = mgr1.create({ rootPath: path.join(tmpDir, "fixture-root"), name: "fixture" });
    await mgr1.activate(created.id);

    expect(mgr1.list().length).toBe(1);
    expect(mgr1.getActiveId()).toBe(created.id);

    // Close the first manager (closes globalStorage1 and ws1 handles).
    mgr1.close();

    // --- Second boot (same files) ---
    const globalStorage2 = openFileGlobalStorage(globalDbPath);
    const ws2 = new WorkspaceStorage(wsBaseDir, bunSqliteFactory);
    const ss2 = new StateService(statePath);
    const bcast2 = mock((_c: string, _e: string, _a: unknown) => {});

    const mgr2 = makeManager(globalStorage2, ws2, ss2, bcast2 as BroadcastFn);
    await mgr2.init();

    expect(mgr2.list().length).toBe(1);
    expect(mgr2.list()[0].id).toBe(created.id);
    expect(mgr2.getActiveId()).toBe(created.id);

    mgr2.close();
  });
});

describe("WorkspaceManager — broadcast events", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("broadcasts 'changed' event when create is called", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();
    broadcastMock.mockClear();

    manager.create({ rootPath: path.join(os.tmpdir(), "test-ws"), name: "test" });

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [ch, ev] = broadcastMock.mock.calls[0] as [string, string, unknown];
    expect(ch).toBe("workspace");
    expect(ev).toBe("changed");

    manager.close();
  });

  it("broadcasts 'changed' event when update is called", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();
    const ws = manager.create({ rootPath: path.join(tmpDir, "ws"), name: "ws" });
    broadcastMock.mockClear();

    manager.update(ws.id, { name: "renamed" });

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [ch, ev, args] = broadcastMock.mock.calls[0] as [
      string,
      string,
      { id: string; name: string },
    ];
    expect(ch).toBe("workspace");
    expect(ev).toBe("changed");
    expect(args.id).toBe(ws.id);
    expect(args.name).toBe("renamed");

    manager.close();
  });

  it("broadcasts 'removed' event with {id} payload when remove is called", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();
    const ws = manager.create({ rootPath: path.join(tmpDir, "ws"), name: "ws" });
    broadcastMock.mockClear();

    manager.remove(ws.id);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [ch, ev, args] = broadcastMock.mock.calls[0] as [string, string, { id: string }];
    expect(ch).toBe("workspace");
    expect(ev).toBe("removed");
    expect(args.id).toBe(ws.id);

    manager.close();
  });
});

describe("WorkspaceManager — executor-ready cold boot barrier", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not expose a local workspace as ready until its agent executor is wired", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const rootPath = path.join(tmpDir, "local-project");
    const meta = workspaceMeta({
      id: "11111111-1111-4111-8111-111111111111",
      name: "local",
      location: { kind: "local", rootPath },
      rootPath,
    });
    globalStorage.addWorkspace(meta);
    stateService.setState({ lastActiveWorkspaceId: meta.id });

    const ready = deferred<void>();
    const { channel } = makeLifecycleChannel(ready.promise);
    const createLocalChannel = mock((() => channel) as WorkspaceLocalChannelFactory);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      undefined,
      fakeSshBootstrap,
      createLocalChannel,
    );
    const registry = new GitRegistry(manager, broadcastMock as BroadcastFn, null);

    const boot = manager.init();
    await Promise.resolve();

    expect(manager.getActiveId()).toBeNull();
    expect(createLocalChannel).toHaveBeenCalledTimes(1);
    await expect(registry.refreshDetection(meta.id)).rejects.toThrow(
      "workspace agent provider is not available",
    );
    expect(() => registry.getRepoInfo(meta.id)).toThrow(
      "workspace agent provider is not available",
    );

    ready.resolve();
    await boot;

    expect(manager.getActiveId()).toBe(meta.id);
    expect(registry.getRepoInfo(meta.id)).toEqual({ kind: "detecting" });

    manager.close();
  });

  it("does not expose an ssh workspace as ready until its agent executor is wired", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const meta = workspaceMeta({
      id: "22222222-2222-4222-8222-222222222222",
      name: "remote",
      location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/project" },
      rootPath: "/srv/project",
    });
    globalStorage.addWorkspace(meta);
    stateService.setState({ lastActiveWorkspaceId: meta.id });

    const ready = deferred<void>();
    const { channel } = makeLifecycleChannel(ready.promise);
    const createChannel = mock((() => channel) as WorkspaceSshChannelFactory);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      createChannel,
    );
    const registry = new GitRegistry(manager, broadcastMock as BroadcastFn, null);

    const boot = manager.init();
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.getActiveId()).toBeNull();
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(() => registry.getRepoInfo(meta.id)).toThrow(
      "workspace agent provider is not available",
    );

    ready.resolve();
    await boot;

    expect(manager.getActiveId()).toBe(meta.id);
    expect(registry.getRepoInfo(meta.id)).toEqual({ kind: "detecting" });

    manager.close();
  });
});

describe("WorkspaceManager — ssh activation lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("waits for the ssh channel before marking the workspace active", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const ready = deferred<void>();
    const calls: Array<{ method: string; params: unknown }> = [];
    const channel: SshChannel = {
      ready: ready.promise,
      call: mock(async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return [{ name: "src", type: "dir" }];
      }),
      on: mock(() => () => {}),
      onLifecycle: mock(() => () => {}),
      dispose: mock(() => {}),
    };
    const createChannel = mock((() => channel) as WorkspaceSshChannelFactory);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      createChannel,
    );

    manager.init();
    const ws = manager.create({
      location: {
        kind: "ssh",
        host: "dev.example.com",
        user: "deploy",
        port: 2222,
        identityFile: "/tmp/key",
        remotePath: "/srv/project",
      },
      name: "remote",
    });

    const activation = manager.activate(ws.id);
    await Promise.resolve();

    expect(manager.getActiveId()).toBeNull();
    expect(createChannel).toHaveBeenCalledWith({
      host: "dev.example.com",
      user: "deploy",
      port: 2222,
      identityFile: "/tmp/key",
      authMode: "interactive",
      remoteCommand: "bash -lc 'exec ~/.nexus-code/bin/agent-0.1.0-linux-amd64 /srv/project'",
    });

    ready.resolve();
    await activation;

    expect(manager.getActiveId()).toBe(ws.id);
    await expect(manager.requireContext(ws.id).fs.readdir(".")).resolves.toEqual([
      { name: "src", type: "dir" },
    ]);
    expect(calls).toEqual([{ method: "fs.readdir", params: { relPath: "." } }]);

    manager.remove(ws.id);
    expect(channel.dispose).toHaveBeenCalledTimes(1);

    globalStorage.close();
  });

  it("passes interactive authMode into bootstrap and reuses bootstrap ControlMaster for the Go agent channel", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const bootstrapDispose = mock(() => {});
    const { channel } = makeLifecycleChannel();
    const createChannel = mock((() => channel) as WorkspaceSshChannelFactory);
    const sshBootstrap = mock(async (options) => ({
      remoteCommand: `bash -lc 'exec ~/.nexus-code/bin/agent-0.1.0-linux-amd64 ${options.remotePath}'`,
      platform: { os: "linux" as const, arch: "amd64" as const },
      uploaded: true,
      controlPath: "/tmp/nexus-ssh/control.sock",
      dispose: bootstrapDispose,
    }));
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      createChannel,
      sshBootstrap,
    );

    manager.init();
    const ws = manager.create({
      location: {
        kind: "ssh",
        host: "127.0.0.1",
        user: "alice",
        port: 2223,
        remotePath: "/workspace-seed",
        authMode: "interactive",
      },
    });

    await manager.activate(ws.id);

    expect(sshBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "interactive", remotePath: "/workspace-seed" }),
    );
    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        authMode: "interactive",
        remoteCommand: "bash -lc 'exec ~/.nexus-code/bin/agent-0.1.0-linux-amd64 /workspace-seed'",
        controlPath: "/tmp/nexus-ssh/control.sock",
      }),
    );

    manager.remove(ws.id);
    expect(bootstrapDispose).toHaveBeenCalledTimes(1);
  });

  it("caches detected remote architecture after the first ssh activation", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const first = makeLifecycleChannel();
    const second = makeLifecycleChannel();
    const channels = [first.channel, second.channel];
    const createChannel = mock((() => {
      const channel = channels.shift();
      if (!channel) throw new Error("unexpected ssh channel creation");
      return channel;
    }) as WorkspaceSshChannelFactory);
    const sshBootstrap = mock(async (options) => ({
      remoteCommand: `bash -lc 'exec ~/.nexus-code/bin/agent-0.1.0-linux-arm64 ${options.remotePath}'`,
      platform: options.cachedRemoteArch ?? { os: "linux" as const, arch: "arm64" as const },
      uploaded: false,
    }));
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      createChannel,
      sshBootstrap,
    );

    manager.init();
    const ws = manager.create({
      location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/project" },
    });

    await manager.activate(ws.id);
    first.emitLifecycle({ type: "exit", code: 0, signal: null });
    await manager.activate(ws.id);

    expect(sshBootstrap.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ cachedRemoteArch: undefined }),
    );
    expect(sshBootstrap.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ cachedRemoteArch: { os: "linux", arch: "arm64" } }),
    );
    expect(manager.requireContext(ws.id).getMeta().location).toEqual(
      expect.objectContaining({ remoteArch: { os: "linux", arch: "arm64" } }),
    );

    manager.close();
  });

  it("broadcasts connecting and connected around ssh activation", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const ready = deferred<void>();
    const { channel } = makeLifecycleChannel(ready.promise);
    const createChannel = mock((() => channel) as WorkspaceSshChannelFactory);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      createChannel,
    );

    manager.init();
    const ws = manager.create({
      location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/project" },
    });
    broadcastMock.mockClear();

    const activation = manager.activate(ws.id);
    await Promise.resolve();

    expect(connectionStatuses(broadcastMock)).toEqual([
      { workspaceId: ws.id, status: "connecting" },
    ]);

    ready.resolve();
    await activation;

    expect(connectionStatuses(broadcastMock)).toEqual([
      { workspaceId: ws.id, status: "connecting" },
      { workspaceId: ws.id, status: "connected" },
    ]);

    manager.close();
  });

  it("broadcasts disconnected when an active ssh channel exits", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const { channel, emitLifecycle } = makeLifecycleChannel();
    const createChannel = mock((() => channel) as WorkspaceSshChannelFactory);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      createChannel,
    );

    manager.init();
    const ws = manager.create({
      location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/project" },
    });
    broadcastMock.mockClear();

    await manager.activate(ws.id);
    emitLifecycle({ type: "exit", code: 0, signal: null });

    expect(connectionStatuses(broadcastMock)).toEqual([
      { workspaceId: ws.id, status: "connecting" },
      { workspaceId: ws.id, status: "connected" },
      { workspaceId: ws.id, status: "disconnected" },
    ]);
    await expect(manager.requireContext(ws.id).fs.readdir(".")).rejects.toThrow(
      "ssh fs provider: channel not yet wired",
    );

    manager.close();
  });

  it("broadcasts error for ssh activation failure without overwriting it on disposal", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const failure = new Error("SSH authentication failed") as Error & { code: SshErrorCode };
    failure.name = "SshError";
    failure.code = "ssh.auth-failed";
    const channel: SshChannel = {
      ready: Promise.reject(failure),
      call: mock(async () => []),
      on: mock(() => () => {}),
      onLifecycle: mock(() => () => {}),
      dispose: mock(() => {}),
    };
    channel.ready.catch(() => {});
    const createChannel = mock((() => channel) as WorkspaceSshChannelFactory);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      createChannel,
    );

    manager.init();
    const ws = manager.create({
      location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/project" },
    });
    broadcastMock.mockClear();

    await expect(manager.activate(ws.id)).rejects.toBe(failure);

    expect(connectionStatuses(broadcastMock)).toEqual([
      { workspaceId: ws.id, status: "connecting" },
      { workspaceId: ws.id, status: "error" },
    ]);
    expect(channel.dispose).toHaveBeenCalledTimes(1);

    manager.close();
  });

  it("reuses one ssh channel per workspace and disposes all channels on close", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const firstDispose = mock(() => {});
    const secondDispose = mock(() => {});
    const channels: SshChannel[] = [
      {
        ready: Promise.resolve(),
        call: mock(async () => []),
        on: mock(() => () => {}),
        onLifecycle: mock(() => () => {}),
        dispose: firstDispose,
      },
      {
        ready: Promise.resolve(),
        call: mock(async () => []),
        on: mock(() => () => {}),
        onLifecycle: mock(() => () => {}),
        dispose: secondDispose,
      },
    ];
    const createChannel = mock((() => {
      const channel = channels.shift();
      if (!channel) {
        throw new Error("unexpected ssh channel creation");
      }
      return channel;
    }) as WorkspaceSshChannelFactory);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      createChannel,
    );

    manager.init();
    const ws1 = manager.create({
      location: { kind: "ssh", host: "one.example.com", remotePath: "/srv/one" },
    });
    const ws2 = manager.create({
      location: { kind: "ssh", host: "two.example.com", remotePath: "/srv/two" },
    });

    await manager.activate(ws1.id);
    await manager.activate(ws1.id);
    await manager.activate(ws2.id);

    expect(createChannel).toHaveBeenCalledTimes(2);
    manager.close();
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  it("throws classified ssh activation failures unchanged and resets to the not-wired provider", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const failure = new Error("SSH authentication failed") as Error & { code: SshErrorCode };
    failure.name = "SshError";
    failure.code = "ssh.auth-failed";
    const channel: SshChannel = {
      ready: Promise.reject(failure),
      call: mock(async () => []),
      on: mock(() => () => {}),
      onLifecycle: mock(() => () => {}),
      dispose: mock(() => {}),
    };
    channel.ready.catch(() => {});
    const createChannel = mock((() => channel) as WorkspaceSshChannelFactory);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
      createChannel,
    );

    manager.init();
    const ws = manager.create({
      location: { kind: "ssh", host: "dev.example.com", remotePath: "/srv/project" },
    });

    await expect(manager.activate(ws.id)).rejects.toBe(failure);
    expect(manager.getActiveId()).toBeNull();
    expect(channel.dispose).toHaveBeenCalledTimes(1);
    await expect(manager.requireContext(ws.id).fs.readdir(".")).rejects.toThrow(
      "ssh fs provider: channel not yet wired",
    );

    globalStorage.close();
  });
});

describe("WorkspaceManager — activate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("activate updates getActiveId and persists to stateService", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();
    const ws1 = manager.create({ rootPath: path.join(os.tmpdir(), "ws1"), name: "ws1" });
    const ws2 = manager.create({ rootPath: path.join(os.tmpdir(), "ws2"), name: "ws2" });

    await manager.activate(ws1.id);
    expect(manager.getActiveId()).toBe(ws1.id);
    expect(stateService.getState().lastActiveWorkspaceId).toBe(ws1.id);

    await manager.activate(ws2.id);
    expect(manager.getActiveId()).toBe(ws2.id);
    expect(stateService.getState().lastActiveWorkspaceId).toBe(ws2.id);

    globalStorage.close();
  });

  it("activate throws for unknown workspace id", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();

    await expect(manager.activate("00000000-0000-0000-0000-000000000099")).rejects.toThrow(
      "workspace not found",
    );

    globalStorage.close();
  });
});

describe("WorkspaceManager — remove + active workspace fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clears active id when the only workspace is removed", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();
    const ws = manager.create({ rootPath: path.join(tmpDir, "ws"), name: "ws" });
    await manager.activate(ws.id);

    manager.remove(ws.id);

    expect(manager.getActiveId()).toBeNull();
    expect(stateService.getState().lastActiveWorkspaceId).toBeUndefined();

    globalStorage.close();
  });

  it("falls back to a remaining workspace when the active one is removed", async () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();
    const ws1 = manager.create({ rootPath: path.join(tmpDir, "ws1"), name: "ws1" });
    const ws2 = manager.create({ rootPath: path.join(tmpDir, "ws2"), name: "ws2" });
    await manager.activate(ws1.id);

    manager.remove(ws1.id);

    expect(manager.getActiveId()).toBe(ws2.id);
    expect(stateService.getState().lastActiveWorkspaceId).toBe(ws2.id);

    globalStorage.close();
  });
});
