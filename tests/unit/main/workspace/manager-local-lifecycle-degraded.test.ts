/**
 * manager-local-lifecycle-degraded.test.ts
 *
 * Regression for the v0.6.0 local-channel teardown bug: 56e411a added the
 * `degraded` / `degraded-recovered` / `ready` lifecycle events, but
 * handleLocalChannelLifecycle still treated "anything except reconnecting /
 * disposed" as terminal. One spuriously late heartbeat then tore down the
 * local provider WITHOUT disposing the channel — abandoning a live agent
 * (orphan process keeping every fs/git watch) and lazily booting a fresh
 * watch-less agent. Push events (fs.changed / git.changed) went silent while
 * RPC kept working, and existing PTY sessions were stranded.
 *
 * Acceptance:
 *  A. `degraded` / `degraded-recovered` / `ready` do NOT tear down the local
 *     provider (no removeShimDir, no second channel boot).
 *  B. `exit` / `failure` still tear it down (removeShimDir fires, and the
 *     next getAgentChannel boots a fresh channel).
 */

import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";

mock.module("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

const { GlobalStorage } = await import("../../../../src/main/infra/storage/global-storage");
const { WorkspaceStorage } = await import(
  "../../../../src/main/infra/storage/workspace-storage"
);
const { StateService } = await import("../../../../src/main/infra/storage/state-service");
const { WorkspaceManager } = await import(
  "../../../../src/main/features/workspace/manager"
);

type ChannelLifecycleCallback = (event: { type: string }) => void;

class StubChannel {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private lifecycleListeners: Set<ChannelLifecycleCallback> = new Set();
  disposed = false;

  constructor() {
    this.ready = new Promise<void>((res) => {
      this.resolveReady = res;
    });
  }

  async call(method: string, _params?: unknown): Promise<unknown> {
    if (method === "hook.getInfo") {
      return { socketPath: "/tmp/hook.sock", token: "tok" };
    }
    return {};
  }

  fire(_method: string, _params?: unknown): void {}

  on(_event: string, _cb: unknown): () => void {
    return () => {};
  }

  onLifecycle(cb: ChannelLifecycleCallback): () => void {
    this.lifecycleListeners.add(cb);
    return () => this.lifecycleListeners.delete(cb);
  }

  emitLifecycle(event: { type: string }): void {
    for (const cb of this.lifecycleListeners) cb(event);
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
  const stateService = new StateService(
    path.join(os.tmpdir(), `nexus-lc-degraded-state-${Date.now()}.json`),
  );
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {});

  const manager = new WorkspaceManager(
    globalStorage,
    workspaceStorage,
    stateService,
    broadcast,
    undefined as never, // sshChannelFactory
    undefined as never, // sshBootstrap
    undefined as never, // localChannelFactory — overridden below
    undefined as never, // localAgentCommandResolver — overridden below
    undefined as never, // sshLspBootstrap
    writeShimFilesMock,
    removeShimDirMock,
  );

  const channels: StubChannel[] = [];
  const m = manager as unknown as {
    localChannelFactory: unknown;
    localAgentCommandResolver: unknown;
  };
  m.localAgentCommandResolver = () => ({ bin: "/usr/bin/agent", args: [] });
  m.localChannelFactory = (_opts: unknown) => {
    const channel = new StubChannel();
    channels.push(channel);
    // Resolve immediately so awaited boots settle without manual pumping.
    channel.resolveChannel();
    return channel;
  };

  return { manager, globalDb, channels, removeShimDirMock };
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

describe("handleLocalChannelLifecycle: health signals must not tear down the provider", () => {
  for (const type of ["degraded", "degraded-recovered", "ready"] as const) {
    test(`'${type}' keeps the provider and does not boot a second channel`, async () => {
      const harness = makeHarness();
      const meta = await bootLocalWorkspace(harness);
      expect(harness.channels).toHaveLength(1);

      harness.channels[0].emitLifecycle({ type });
      await settle();

      // No teardown side effects.
      expect(harness.removeShimDirMock).not.toHaveBeenCalled();

      // The same channel keeps serving — a re-request must NOT boot a new one.
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

      // Next request boots a fresh channel.
      await harness.manager.getAgentChannel(meta.id);
      expect(harness.channels).toHaveLength(2);

      harness.globalDb.close();
    });
  }
});
