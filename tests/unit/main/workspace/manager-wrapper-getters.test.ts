/**
 * WorkspaceManager.getWrapperBinDir / getWrapperAgentBin 단위 테스트.
 *
 * 이 테스트는 WorkspaceManager의 두 getter 메서드가
 * 워크스페이스 종류(local / ssh / unknown)에 따라 올바른 경로를 반환하는지 검증한다.
 *
 * - acceptance #1: getWrapperBinDir(localWs) → getAgentBinDir() 동일 값
 * - acceptance #2: getWrapperBinDir(sshWs)   → bootstrap.remoteBinDir
 * - acceptance #3: getWrapperBinDir(unknownWs) → null
 * - acceptance #4: getWrapperAgentBin(localWs) → getAgentBinaryPath() 동일 값
 * - acceptance #5: getWrapperAgentBin(sshWs)  → remoteBinDir/agent-<...> 형식
 *
 * electron mock이 필요하므로 mock.module()을 import보다 먼저 선언하고
 * dynamic import로 대상 모듈을 로드한다.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { LOCAL_AGENT_DIST_DIR } from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/types";

// ---------------------------------------------------------------------------
// electron mock — isPackaged=false (dev 모드) 고정
// ---------------------------------------------------------------------------

mock.module("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

// dynamic import — mock.module 이후
const { GlobalStorage } = await import("../../../../src/main/infra/storage/global-storage");
const { WorkspaceStorage } = await import(
  "../../../../src/main/infra/storage/workspace-storage"
);
const { StateService } = await import("../../../../src/main/infra/storage/state-service");
const { WorkspaceManager } = await import(
  "../../../../src/main/features/workspace/manager"
);
const { getAgentBinDir, getAgentBinaryPath } = await import(
  "../../../../src/main/infra/agent/getAgentBinDir"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REMOTE_HOME = "/home/testuser";
const REMOTE_BIN_DIR = `${REMOTE_HOME}/.nexus-code/bin`;

/** 최소 EnsureRemoteAgentResult stub */
function makeSshBootstrap(overrides: Partial<{
  remoteBinDir: string;
  platform: { os: "linux" | "darwin"; arch: "amd64" | "arm64" };
}> = {}) {
  return {
    remoteCommand: "bash -lc 'exec /home/testuser/.nexus-code/bin/agent-0.1.0-linux-amd64'",
    remoteHome: REMOTE_HOME,
    platform: overrides.platform ?? { os: "linux" as const, arch: "amd64" as const },
    uploaded: false,
    remoteBinDir: overrides.remoteBinDir ?? REMOTE_BIN_DIR,
  };
}

function makeManager() {
  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);
  const wsBaseDir = path.join(os.tmpdir(), `nexus-wrapper-getter-test-${Date.now()}`);
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, () => new Database(":memory:"));
  const stateService = new StateService(path.join(os.tmpdir(), `nexus-getter-state-${Date.now()}.json`));
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {});

  const manager = new WorkspaceManager(
    globalStorage,
    workspaceStorage,
    stateService,
    broadcast,
  );

  return { manager, globalDb };
}

/**
 * WorkspaceManager의 private sshBootstraps 맵에 직접 접근하기 위한 타입 캐스트.
 * 테스트 전용 — 프로덕션 코드에서는 startSshProvider 내부에서만 설정된다.
 */
function injectSshBootstrap(
  manager: InstanceType<typeof WorkspaceManager>,
  workspaceId: string,
  bootstrap: ReturnType<typeof makeSshBootstrap>,
) {
  const m = manager as unknown as {
    sshBootstraps: Map<string, ReturnType<typeof makeSshBootstrap>>;
  };
  m.sshBootstraps.set(workspaceId, bootstrap);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceManager.getWrapperBinDir — acceptance #1, #2, #3", () => {
  test("#1: 로컬 워크스페이스 → getAgentBinDir() 동일 값", () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({ rootPath: path.join(os.tmpdir(), "ws-local-bindir"), name: "local" });

    const result = manager.getWrapperBinDir(meta.id);

    expect(result).toBe(getAgentBinDir());
    globalDb.close();
  });

  test("#2: SSH 워크스페이스 → bootstrap.remoteBinDir 동일 값", () => {
    const { manager, globalDb } = makeManager();
    // SSH 워크스페이스를 직접 생성하고 bootstrap을 주입한다.
    const meta = manager.create({
      location: {
        kind: "ssh",
        host: "test.example.com",
        user: "testuser",
        remotePath: "/home/testuser/projects/foo",
        authMode: "key-only",
      },
      name: "ssh-ws",
    });
    const bootstrap = makeSshBootstrap({ remoteBinDir: REMOTE_BIN_DIR });
    injectSshBootstrap(manager, meta.id, bootstrap);

    const result = manager.getWrapperBinDir(meta.id);

    expect(result).toBe(REMOTE_BIN_DIR);
    globalDb.close();
  });

  test("#3: 존재하지 않는 워크스페이스 → null", () => {
    const { manager, globalDb } = makeManager();

    const result = manager.getWrapperBinDir("nonexistent-ws-id");

    expect(result).toBeNull();
    globalDb.close();
  });

  test("SSH 워크스페이스지만 bootstrap이 없으면 → null", () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({
      location: {
        kind: "ssh",
        host: "test.example.com",
        user: "testuser",
        remotePath: "/home/testuser/projects/foo",
        authMode: "key-only",
      },
      name: "ssh-ws-no-bootstrap",
    });
    // bootstrap 없이 조회

    const result = manager.getWrapperBinDir(meta.id);

    expect(result).toBeNull();
    globalDb.close();
  });
});

describe("WorkspaceManager.getWrapperAgentBin — acceptance #4, #5", () => {
  test("#4: 로컬 워크스페이스 → getAgentBinaryPath() 동일 값 (undefined → null 변환)", () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({
      rootPath: path.join(os.tmpdir(), "ws-local-agentbin"),
      name: "local-agent",
    });

    const result = manager.getWrapperAgentBin(meta.id);
    const expected = getAgentBinaryPath() ?? null;

    expect(result).toBe(expected);
    globalDb.close();
  });

  test("#5: SSH 워크스페이스 → remoteBinDir/agent-<version>-<os>-<arch> 형식", () => {
    // manifest.json이 없는 경우 null을 반환하므로, 먼저 manifest 유무를 확인한다.
    const manifestExists = fs.existsSync(
      path.join(LOCAL_AGENT_DIST_DIR, "manifest.json"),
    );

    const { manager, globalDb } = makeManager();
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

    const result = manager.getWrapperAgentBin(meta.id);

    if (manifestExists) {
      // manifest가 있으면 agent-<version>-linux-amd64 형식이어야 한다.
      expect(result).not.toBeNull();
      expect(result).toMatch(/^\/home\/testuser\/\.nexus-code\/bin\/agent-\S+-linux-amd64$/);
    } else {
      // manifest가 없으면 null.
      expect(result).toBeNull();
    }

    globalDb.close();
  });

  test("존재하지 않는 워크스페이스 → null", () => {
    const { manager, globalDb } = makeManager();

    const result = manager.getWrapperAgentBin("nonexistent-ws-id");

    expect(result).toBeNull();
    globalDb.close();
  });

  test("SSH 워크스페이스지만 bootstrap이 없으면 → null", () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({
      location: {
        kind: "ssh",
        host: "test.example.com",
        user: "testuser",
        remotePath: "/home/testuser/projects/baz",
        authMode: "key-only",
      },
      name: "ssh-ws-no-bootstrap-agent",
    });

    const result = manager.getWrapperAgentBin(meta.id);

    expect(result).toBeNull();
    globalDb.close();
  });
});
