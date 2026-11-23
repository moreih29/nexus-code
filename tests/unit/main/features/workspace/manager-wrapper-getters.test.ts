import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_PROTOCOL_VERSION } from "../../../../../src/shared/agent/envelope";

const electronApp = { isPackaged: false };
mock.module("electron", () => ({
  app: electronApp,
}));

const WINDOWS_LAUNCHER_DIR = path.join(os.tmpdir(), "nexus-cli-launchers");
const realLaunchers = await import("../../../../../src/main/features/cli/launchers");
mock.module("../../../../../src/main/features/cli/launchers", () => ({
  ...realLaunchers,
  windowsCliLauncherDir: () => WINDOWS_LAUNCHER_DIR,
}));

const { GlobalStorage } = await import("../../../../../src/main/infra/storage/global-storage");
const { WorkspaceStorage } = await import(
  "../../../../../src/main/infra/storage/workspace-storage"
);
const { openTestState } = await import("../../../../helpers/test-state");
const { WorkspaceManager } = await import("../../../../../src/main/features/workspace/manager");
const { loginShell } = await import("../../../../../src/main/infra/platform");

const REMOTE_HOME = "/home/testuser";
const REMOTE_BIN_DIR = `${REMOTE_HOME}/.nexus-code/bin`;

function makeSshBootstrap(
  overrides: Partial<{
    remoteBinDir: string;
    platform: { os: "linux" | "darwin"; arch: "amd64" | "arm64" };
    remoteShell: string | undefined;
    remoteShimDir: string | undefined;
  }> = {},
) {
  return {
    remoteCommand: "bash -lc 'exec /home/testuser/.nexus-code/bin/agent-0.1.0-linux-amd64'",
    remoteHome: REMOTE_HOME,
    platform: overrides.platform ?? { os: "linux" as const, arch: "amd64" as const },
    uploaded: false,
    remoteBinDir: overrides.remoteBinDir ?? REMOTE_BIN_DIR,
    remoteShell: overrides.remoteShell,
    remoteShimDir: overrides.remoteShimDir,
  };
}

function makeManager() {
  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);
  const wsBaseDir = path.join(os.tmpdir(), `nexus-wrapper-getter-test-${Date.now()}`);
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, () => new Database(":memory:"));
  const stateService = openTestState(
    path.join(os.tmpdir(), `nexus-getter-state-${Date.now()}.json`),
  );
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {});

  const manager = new WorkspaceManager(globalStorage, workspaceStorage, stateService, broadcast);

  return { manager, globalDb };
}

function writeAgentManifest(dir: string, version: string): void {
  const sha256 = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      version,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      binaries: [
        { os: "linux", arch: "amd64", path: `agent-${version}-linux-amd64`, sha256, size: 1 },
      ],
      runtime: {
        node: [
          {
            os: "linux",
            arch: "amd64",
            version: "v20.19.0",
            path: "runtime/node.tar.gz",
            sha256,
            size: 1,
            entry: "bin/node",
          },
        ],
      },
      lspBinaries: [],
    }),
  );
}

function injectSshBootstrap(
  manager: InstanceType<typeof WorkspaceManager>,
  workspaceId: string,
  bootstrap: ReturnType<typeof makeSshBootstrap>,
) {
  const m = manager as unknown as {
    remote: { sshBootstraps: Map<string, ReturnType<typeof makeSshBootstrap>> };
  };
  m.remote.sshBootstraps.set(workspaceId, bootstrap);
}

const isWindows = process.platform === "win32";
const posixTest = test.skipIf(isWindows);
const windowsTest = test.skipIf(!isWindows);

describe("WorkspaceManager.getWrapperBinDir — acceptance #1, #2, #3", () => {
  windowsTest("#1w: Windows 로컬 워크스페이스 → nexus 런처 디렉터리", () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({
      rootPath: path.join(os.tmpdir(), "ws-local-bindir"),
      name: "local",
    });

    expect(manager.getWrapperBinDir(meta.id)).toBe(WINDOWS_LAUNCHER_DIR);
    globalDb.close();
  });
});

describe("WorkspaceManager.getWrapperAgentBin — acceptance #4, #5", () => {
  test("#5: SSH 워크스페이스 → remoteBinDir/agent-<version>-<os>-<arch> 형식", () => {
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wrapper-manifest-"));
    const setResourcesPath = (value: string | undefined) =>
      Object.defineProperty(process, "resourcesPath", {
        value,
        configurable: true,
        writable: true,
      });
    const originalResourcesPath = process.resourcesPath;
    electronApp.isPackaged = true;
    setResourcesPath(resourcesPath);

    const { manager, globalDb } = makeManager();
    try {
      const meta = manager.create({
        location: {
          kind: "ssh",
          host: "test.example.com",
          user: "testuser",
          remotePath: "/home/testuser/projects/bar",
          authMode: "key-only",
        },
        name: "ssh-ws-agent",
      });
      const bootstrap = makeSshBootstrap({
        remoteBinDir: REMOTE_BIN_DIR,
        platform: { os: "linux", arch: "amd64" },
      });
      injectSshBootstrap(manager, meta.id, bootstrap);

      expect(manager.getWrapperAgentBin(meta.id)).toBeNull();

      writeAgentManifest(path.join(resourcesPath, "agent"), "9.8.7");
      expect(manager.getWrapperAgentBin(meta.id)).toBe(`${REMOTE_BIN_DIR}/agent-9.8.7-linux-amd64`);
    } finally {
      electronApp.isPackaged = false;
      setResourcesPath(originalResourcesPath);
      fs.rmSync(resourcesPath, { recursive: true, force: true });
      globalDb.close();
    }
  });
});

describe("WorkspaceManager.getWrapperShell — acceptance #6, #7, #8", () => {
  let savedShell: string | undefined;
  beforeEach(() => {
    savedShell = process.env.SHELL;
  });

  function restoreShell() {
    if (savedShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = savedShell;
  }

  posixTest("#6b: local workspace without $SHELL → the account's login shell", () => {
    delete process.env.SHELL;
    try {
      const { manager, globalDb } = makeManager();
      const meta = manager.create({
        rootPath: path.join(os.tmpdir(), "ws-local-shell-missing"),
        name: "local-shell-missing",
      });

      const result = manager.getWrapperShell(meta.id);

      expect(result).toBe(loginShell());
      globalDb.close();
    } finally {
      restoreShell();
    }
  });

  posixTest("#6c: local workspace with an empty $SHELL → the account's login shell", () => {
    process.env.SHELL = "";
    try {
      const { manager, globalDb } = makeManager();
      const meta = manager.create({
        rootPath: path.join(os.tmpdir(), "ws-local-shell-empty"),
        name: "local-shell-empty",
      });

      const result = manager.getWrapperShell(meta.id);

      expect(result).toBe(loginShell());
      globalDb.close();
    } finally {
      restoreShell();
    }
  });

  windowsTest("#6w: Windows 로컬 워크스페이스 → $SHELL과 무관하게 null", () => {
    process.env.SHELL = "/bin/zsh";
    try {
      const { manager, globalDb } = makeManager();
      const meta = manager.create({
        rootPath: path.join(os.tmpdir(), "ws-local-shell"),
        name: "local-shell",
      });

      expect(manager.getWrapperShell(meta.id)).toBeNull();
      globalDb.close();
    } finally {
      restoreShell();
    }
  });
});
