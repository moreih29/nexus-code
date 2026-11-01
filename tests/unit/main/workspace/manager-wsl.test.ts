/**
 * A WSL workspace boots like an SSH one, with the agent installed and reached
 * through the WSL transport the manager is given.
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
const { WorkspaceStorage } = await import("../../../../src/main/infra/storage/workspace-storage");
const { StateService } = await import("../../../../src/main/infra/storage/state-service");
const { WorkspaceManager } = await import("../../../../src/main/features/workspace/manager");

class StubChannel {
  readonly ready = Promise.resolve();
  async call(method: string): Promise<unknown> {
    if (method === "hook.getInfo") return { socketPath: "/home/me/.nexus-code/h.sock", token: "t" };
    return {};
  }
  fire(): void {}
  on(): () => void {
    return () => {};
  }
  onLifecycle(): () => void {
    return () => {};
  }
  dispose(): void {}
}

function makeManager() {
  const globalDb = new Database(":memory:");
  const tmp = path.join(os.tmpdir(), `nexus-wsl-${Date.now()}-${Math.random()}`);
  const channel = new StubChannel();
  const wsl = {
    bootstrap: mock(async (_options: { distro: string; remotePath: string }) => ({
      remoteCommand: "bash -lc 'agent --dial sock'",
      remoteHome: "/home/me",
      platform: { os: "linux" as const, arch: "amd64" as const },
      uploaded: false,
      remoteBinDir: "/home/me/.nexus-code/bin",
      remoteShell: "/usr/bin/zsh",
      remoteShimDir: "/home/me/.nexus-code/shim/x",
    })),
    createChannel: mock((_options: { distro: string; remoteCommand: string }) => channel),
    lspBootstrap: mock(async (_options: { distro: string; binaryName: string }) => ({
      binaryPath: "/home/me/.nexus-code/lsp/gopls",
      args: ["serve"],
      platform: { os: "linux" as const, arch: "amd64" as const },
      uploaded: false,
    })),
  };
  const broadcast = mock((_channel: string, _event: string, _args: unknown) => {});
  const manager = new WorkspaceManager(
    new GlobalStorage(globalDb),
    new WorkspaceStorage(tmp, () => new Database(":memory:")),
    new StateService(`${tmp}-state.json`),
    broadcast,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    async () => ({ dir: "/s", zshrc: "/s/.zshrc", zshenv: "/s/.zshenv", bashrc: "/s/bashrc" }),
    async () => {},
    wsl as never,
  );
  return { manager, wsl, channel, broadcast, globalDb };
}

const location = { kind: "wsl" as const, distro: "Ubuntu", remotePath: "/home/me/project" };

describe("WSL workspace", () => {
  test("installs and reaches the agent in the distribution", async () => {
    const { manager, wsl, channel, broadcast, globalDb } = makeManager();
    const meta = manager.create({ location });

    expect(await manager.getAgentChannel(meta.id)).toBe(channel as never);

    expect(wsl.bootstrap).toHaveBeenCalledTimes(1);
    expect(wsl.bootstrap.mock.calls[0][0]).toEqual({
      distro: "Ubuntu",
      remotePath: "/home/me/project",
      cachedRemoteArch: undefined,
      workspaceId: meta.id,
    });
    expect(wsl.createChannel).toHaveBeenCalledWith({
      distro: "Ubuntu",
      remoteCommand: "bash -lc 'agent --dial sock'",
    });
    expect(broadcast).toHaveBeenCalledWith("workspace", "connectionChanged", {
      workspaceId: meta.id,
      status: "connected",
    });
    globalDb.close();
  });

  test("remembers the distribution's architecture, and gives terminals its Claude wrapper", async () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({ location });
    await manager.getAgentChannel(meta.id);

    expect(manager.list().find((w) => w.id === meta.id)?.location).toEqual({
      ...location,
      remoteArch: { os: "linux", arch: "amd64" },
    });
    expect(manager.isLocal(meta.id)).toBe(false);
    expect(manager.getWrapperBinDir(meta.id)).toBe("/home/me/.nexus-code/bin");
    expect(manager.getWrapperShell(meta.id)).toBe("/usr/bin/zsh");
    expect(manager.getWrapperShimDir(meta.id)).toBe("/home/me/.nexus-code/shim/x");
    globalDb.close();
  });

  test("installs bundled language servers in the distribution", async () => {
    const { manager, wsl, globalDb } = makeManager();
    const meta = manager.create({ location });

    const server = await manager.ensureRemoteLspServer(meta.id, {
      binaryName: "gopls",
      languageId: "go",
      args: [],
    });

    expect(server).toEqual({ binaryPath: "/home/me/.nexus-code/lsp/gopls", args: ["serve"] });
    expect(wsl.lspBootstrap.mock.calls[0][0]).toMatchObject({
      distro: "Ubuntu",
      remotePath: "/home/me/project",
      binaryName: "gopls",
    });
    globalDb.close();
  });

  test("is named after its folder, or its distribution at the root", () => {
    const { manager, globalDb } = makeManager();

    expect(manager.create({ location }).name).toBe("project");
    expect(manager.create({ location: { ...location, remotePath: "/" } }).name).toBe("Ubuntu");
    globalDb.close();
  });
});
