/**
 * manager-shim-lifecycle.test.ts
 *
 * Acceptance criteria 10-12:
 *  10. startLocalProvider 호출 시 writeShimFiles(workspaceId) 1회
 *  11. startSshProvider 호출 시 writeShimFiles(workspaceId) 1회
 *  12. lifecycle terminal handler에서 removeShimDir(workspaceId) 호출
 *
 * writeShimFiles / removeShimDir 을 WorkspaceManager 생성자 DI로 주입하여
 * mock.module 없이 격리 검증한다.  runtimeDirs 모듈은 전혀 건드리지 않는다.
 */

import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// electron mock — isPackaged=false (dev 모드) 고정.
// runtimeDirs 모듈은 mock 하지 않으므로 이 mock 하나면 충분하다.
// ---------------------------------------------------------------------------

mock.module("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

// ---------------------------------------------------------------------------
// Dynamic imports — must follow all mock.module() calls
// ---------------------------------------------------------------------------

const { GlobalStorage } = await import("../../../../src/main/infra/storage/global-storage");
const { WorkspaceStorage } = await import(
  "../../../../src/main/infra/storage/workspace-storage"
);
const { StateService } = await import("../../../../src/main/infra/storage/state-service");
const { WorkspaceManager } = await import(
  "../../../../src/main/features/workspace/manager"
);

// ---------------------------------------------------------------------------
// Channel / channel factory stubs
// ---------------------------------------------------------------------------

type ChannelLifecycleCallback = (event: { type: string }) => void;

class StubChannel {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private lifecycleListeners: Set<ChannelLifecycleCallback> = new Set();
  readonly calls: Array<{ method: string; params: unknown }> = [];

  constructor() {
    this.ready = new Promise<void>((res) => { this.resolveReady = res; });
  }

  // Called during hook.getInfo + writeShimFiles
  async call(method: string, _params?: unknown): Promise<unknown> {
    this.calls.push({ method, params: _params });
    if (method === "hook.getInfo") {
      return { socketPath: "/tmp/hook.sock", token: "tok" };
    }
    return {};
  }

  fire(_method: string, _params?: unknown): void {}

  on(_event: string, _cb: unknown): () => void { return () => {}; }

  onLifecycle(cb: ChannelLifecycleCallback): () => void {
    this.lifecycleListeners.add(cb);
    return () => this.lifecycleListeners.delete(cb);
  }

  emitLifecycle(event: { type: string }): void {
    for (const cb of this.lifecycleListeners) cb(event);
  }

  resolveChannel(): void { this.resolveReady(); }

  dispose(): void {}
}

// ---------------------------------------------------------------------------
// DI-based shim fake factories — returned per test so mocks are isolated
// ---------------------------------------------------------------------------

function makeShimFakes() {
  const writeShimFilesMock = mock((_workspaceId: string) => Promise.resolve({
    dir: "/stub/shim",
    zshrc: "/stub/shim/.zshrc",
    zshenv: "/stub/shim/.zshenv",
    bashrc: "/stub/shim/bashrc",
  }));
  const removeShimDirMock = mock((_workspaceId: string) => Promise.resolve());
  return { writeShimFilesMock, removeShimDirMock };
}

// ---------------------------------------------------------------------------
// Manager factory — injects shim fakes via constructor DI
// ---------------------------------------------------------------------------

function makeManager(
  writeShimFilesFn: Parameters<typeof WorkspaceManager>[9],
  removeShimDirFn: Parameters<typeof WorkspaceManager>[10],
) {
  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);
  const wsBaseDir = path.join(os.tmpdir(), `nexus-shim-lc-${Date.now()}`);
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, () => new Database(":memory:"));
  const stateService = new StateService(
    path.join(os.tmpdir(), `nexus-shim-lc-state-${Date.now()}.json`),
  );
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {});

  // Constructor positional order:
  // globalStorage, workspaceStorage, stateService, broadcastFn,
  // sshChannelFactory, sshBootstrap, localChannelFactory, localAgentCommandResolver,
  // sshLspBootstrap, writeShimFiles, removeShimDir
  const manager = new WorkspaceManager(
    globalStorage,
    workspaceStorage,
    stateService,
    broadcast,
    undefined as never, // sshChannelFactory — default
    undefined as never, // sshBootstrap — default
    undefined as never, // localChannelFactory — default (overridden per test)
    undefined as never, // localAgentCommandResolver — default (overridden per test)
    undefined as never, // sshLspBootstrap — default
    writeShimFilesFn,
    removeShimDirFn,
  );

  return { manager, globalDb };
}

// ---------------------------------------------------------------------------
// Acceptance 10: startLocalProvider calls writeShimFiles once
// ---------------------------------------------------------------------------

describe("acceptance 10: startLocalProvider → writeShimFiles(workspaceId) 1회", () => {
  test("local workspace provider boot writes shim files for the workspace", async () => {
    const { writeShimFilesMock, removeShimDirMock } = makeShimFakes();

    const channel = new StubChannel();

    const { manager, globalDb } = makeManager(writeShimFilesMock, removeShimDirMock);
    const meta = manager.create({
      rootPath: path.join(os.tmpdir(), "shim-lc-local"),
      name: "shim-local",
    });

    // Override localChannelFactory to inject our stub channel
    const m = manager as unknown as {
      localChannelFactory: unknown;
      localAgentCommandResolver: unknown;
    };
    m.localAgentCommandResolver = () => ({ bin: "/usr/bin/agent", args: [] });
    m.localChannelFactory = (_opts: unknown) => channel;

    // Boot the provider asynchronously
    const bootPromise = manager.getAgentChannel(meta.id);

    // Allow the channel.ready to resolve
    channel.resolveChannel();
    await bootPromise;

    expect(writeShimFilesMock).toHaveBeenCalledTimes(1);
    expect(writeShimFilesMock.mock.calls[0][0]).toBe(meta.id);

    globalDb.close();
  });
});

// ---------------------------------------------------------------------------
// Acceptance 11: startSshProvider calls writeShimFiles once
// ---------------------------------------------------------------------------

describe("acceptance 11: startSshProvider → writeShimFiles(workspaceId) 1회", () => {
  test("ssh workspace provider boot writes shim files for the workspace", async () => {
    const { writeShimFilesMock, removeShimDirMock } = makeShimFakes();

    const channel = new StubChannel();

    const sshBootstrapMock = mock(async (_opts: unknown) => ({
      remoteCommand: "exec agent",
      remoteHome: "/home/user",
      platform: { os: "linux" as const, arch: "amd64" as const },
      uploaded: false,
      remoteBinDir: "/home/user/.nexus-code/bin",
      controlPath: undefined,
      dispose: undefined,
    }));

    const { manager, globalDb } = makeManager(writeShimFilesMock, removeShimDirMock);
    const meta = manager.create({
      location: {
        kind: "ssh" as const,
        host: "test.example.com",
        user: "testuser",
        remotePath: "/home/testuser/project",
        authMode: "key-only" as const,
      },
      name: "shim-ssh",
    });

    // Inject stub bootstrap and channel factory
    const m = manager as unknown as {
      sshBootstrap: unknown;
      sshChannelFactory: unknown;
    };
    m.sshBootstrap = sshBootstrapMock;
    m.sshChannelFactory = (_opts: unknown) => channel;

    const bootPromise = manager.getAgentChannel(meta.id);
    channel.resolveChannel();
    await bootPromise;

    expect(writeShimFilesMock).toHaveBeenCalledTimes(1);
    expect(writeShimFilesMock.mock.calls[0][0]).toBe(meta.id);

    globalDb.close();
  });
});

// ---------------------------------------------------------------------------
// Acceptance 12: lifecycle terminal handler calls removeShimDir
// ---------------------------------------------------------------------------

describe("acceptance 12: lifecycle terminal handler → removeShimDir(workspaceId) 호출", () => {
  test("local channel terminal lifecycle event triggers removeShimDir", async () => {
    const { writeShimFilesMock, removeShimDirMock } = makeShimFakes();

    const channel = new StubChannel();

    const { manager, globalDb } = makeManager(writeShimFilesMock, removeShimDirMock);
    const meta = manager.create({
      rootPath: path.join(os.tmpdir(), "shim-lc-remove"),
      name: "shim-remove",
    });

    const m = manager as unknown as {
      localChannelFactory: unknown;
      localAgentCommandResolver: unknown;
    };
    m.localAgentCommandResolver = () => ({ bin: "/usr/bin/agent", args: [] });
    m.localChannelFactory = (_opts: unknown) => channel;

    const bootPromise = manager.getAgentChannel(meta.id);
    channel.resolveChannel();
    await bootPromise;

    // Now emit a terminal lifecycle event (type != "reconnecting" and != "disposed")
    // This triggers handleLocalChannelLifecycle and should fire removeShimDir.
    channel.emitLifecycle({ type: "failure" });

    // Give fire-and-forget promise a tick to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(removeShimDirMock).toHaveBeenCalledTimes(1);
    expect(removeShimDirMock.mock.calls[0][0]).toBe(meta.id);

    globalDb.close();
  });
});
