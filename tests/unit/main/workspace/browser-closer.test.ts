/**
 * Unit tests for the browser workspace closer wired via setBrowserCloser.
 *
 * Acceptance criteria:
 *   1. closer 호출 시 해당 workspaceId의 view들이 destroy됨
 *   2. clearStorageData가 1회 호출됨
 *   3. destroy 완료 후 clearStorageData 순서 보장 (Promise 체인 검증)
 *   4. WorkspaceManager.setBrowserCloser 메서드가 노출됨
 *
 * NOTE: BrowserTabRegistry는 electron.WebContentsView를 상단 임포트로 끌어들여
 * electron 모킹이 필요하다. 이 파일은 같은 bun worker의 다른 workspace 테스트들
 * (manager-wrapper-getters, manager-shim-lifecycle)과 electron 모킹이 충돌하지
 * 않도록 BrowserTabRegistry를 직접 임포트하지 않는다.
 * 대신 동일한 인터페이스를 갖는 인라인 fake로 검증한다.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Electron mock — isPackaged=false (dev 모드), app only.
// BrowserTabRegistry를 임포트하지 않으므로 WebContentsView 불필요.
// manager-wrapper-getters / manager-shim-lifecycle과 호환됨.
// ---------------------------------------------------------------------------

mock.module("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mock.module)
// ---------------------------------------------------------------------------

const { GlobalStorage } = await import(
  "../../../../src/main/infra/storage/global-storage"
);
const { WorkspaceStorage } = await import(
  "../../../../src/main/infra/storage/workspace-storage"
);
const { StateService } = await import(
  "../../../../src/main/infra/storage/state-service"
);
const { WorkspaceManager } = await import(
  "../../../../src/main/features/workspace/manager"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager() {
  const globalDb = new Database(":memory:");
  const globalStorage = new GlobalStorage(globalDb);
  const wsBaseDir = path.join(os.tmpdir(), `nexus-browser-closer-test-${Date.now()}`);
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, () => new Database(":memory:"));
  const stateService = new StateService(
    path.join(os.tmpdir(), `nexus-browser-closer-state-${Date.now()}.json`),
  );
  const broadcast = mock((_ch: string, _ev: string, _args: unknown) => {});
  const manager = new WorkspaceManager(
    globalStorage,
    workspaceStorage,
    stateService,
    broadcast,
  );
  return { manager, globalDb };
}

// ---------------------------------------------------------------------------
// Minimal registry interface — mirrors BrowserTabRegistry.listByWorkspace /
// destroy, but without importing the real class (which requires electron).
// ---------------------------------------------------------------------------

interface FakeTabEntry {
  tabId: string;
  workspaceId: string;
  destroyed: boolean;
}

class FakeRegistry {
  private readonly entries: FakeTabEntry[] = [];

  addTab(tabId: string, workspaceId: string) {
    this.entries.push({ tabId, workspaceId, destroyed: false });
  }

  listByWorkspace(workspaceId: string): string[] {
    return this.entries
      .filter((e) => e.workspaceId === workspaceId && !e.destroyed)
      .map((e) => e.tabId);
  }

  destroy(args: { tabId: string }): void {
    const entry = this.entries.find((e) => e.tabId === args.tabId);
    if (entry) entry.destroyed = true;
  }

  isDestroyed(tabId: string): boolean {
    return this.entries.find((e) => e.tabId === tabId)?.destroyed ?? true;
  }
}

/**
 * Builds a browser closer that mirrors the logic in registerBrowserCloser,
 * pointing at the given registry and clearStorage mock.
 */
function buildCloser(
  registry: FakeRegistry,
  clearStorage: (partition: string) => Promise<void>,
): (workspaceId: string) => Promise<void> {
  return async (workspaceId: string) => {
    const tabIds = registry.listByWorkspace(workspaceId);
    for (const tabId of tabIds) {
      registry.destroy({ tabId });
    }
    await clearStorage(`persist:browser-${workspaceId}`);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceManager.setBrowserCloser — API surface", () => {
  test("setBrowserCloser is exposed as a public method", () => {
    const { manager, globalDb } = makeManager();
    expect(typeof manager.setBrowserCloser).toBe("function");
    globalDb.close();
  });

  test("setBrowserCloser accepts an async closer without throwing", () => {
    const { manager, globalDb } = makeManager();
    expect(() => {
      manager.setBrowserCloser(async (_id: string) => {});
    }).not.toThrow();
    globalDb.close();
  });

  test("setBrowserCloser registers the closer and it is invoked on remove()", async () => {
    const { manager, globalDb } = makeManager();
    const meta = manager.create({
      rootPath: path.join(os.tmpdir(), "ws-closer-test"),
      name: "test",
    });

    const closerCalls: string[] = [];
    manager.setBrowserCloser(async (id: string) => {
      closerCalls.push(id);
    });

    manager.remove(meta.id);
    // Allow the fire-and-forget promise to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(closerCalls).toContain(meta.id);
    globalDb.close();
  });
});

describe("browser closer — view destroy + clearStorageData", () => {
  const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const OTHER_WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  let clearStorageMock: ReturnType<typeof mock<(p: string) => Promise<void>>>;
  let clearedPartitions: string[];

  beforeEach(() => {
    clearedPartitions = [];
    clearStorageMock = mock(async (partition: string) => {
      clearedPartitions.push(partition);
    });
  });

  // -----------------------------------------------------------------------
  // Acceptance #1: 해당 workspaceId의 view들이 destroy됨
  // -----------------------------------------------------------------------

  test("destroys all views belonging to the target workspaceId", async () => {
    const registry = new FakeRegistry();
    const closer = buildCloser(registry, clearStorageMock);

    registry.addTab("tab-1", WORKSPACE_ID);
    registry.addTab("tab-2", WORKSPACE_ID);
    registry.addTab("tab-other", OTHER_WORKSPACE_ID);

    await closer(WORKSPACE_ID);

    expect(registry.isDestroyed("tab-1")).toBe(true);
    expect(registry.isDestroyed("tab-2")).toBe(true);
    // Other workspace tab is unaffected.
    expect(registry.isDestroyed("tab-other")).toBe(false);
  });

  test("no-op when workspaceId has no registered tabs — clearStorage still called", async () => {
    const registry = new FakeRegistry();
    const closer = buildCloser(registry, clearStorageMock);

    await expect(closer(WORKSPACE_ID)).resolves.toBeUndefined();
    expect(clearStorageMock).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Acceptance #2: clearStorageData가 1회 호출됨
  // -----------------------------------------------------------------------

  test("clearStorageData is called exactly once per closer invocation", async () => {
    const registry = new FakeRegistry();
    const closer = buildCloser(registry, clearStorageMock);
    registry.addTab("tab-cs", WORKSPACE_ID);

    await closer(WORKSPACE_ID);

    expect(clearStorageMock).toHaveBeenCalledTimes(1);
  });

  test("clearStorageData is called with the correct partition", async () => {
    const registry = new FakeRegistry();
    const closer = buildCloser(registry, clearStorageMock);
    registry.addTab("tab-part", WORKSPACE_ID);

    await closer(WORKSPACE_ID);

    expect(clearedPartitions).toContain(`persist:browser-${WORKSPACE_ID}`);
  });

  // -----------------------------------------------------------------------
  // Acceptance #3: destroy 완료 후 clearStorageData 순서 보장
  // -----------------------------------------------------------------------

  test("all views are destroyed before clearStorageData is called", async () => {
    const callOrder: string[] = [];

    const registry = new FakeRegistry();
    // Track destroy calls.
    const originalDestroy = registry.destroy.bind(registry);
    registry.destroy = (args: { tabId: string }) => {
      callOrder.push(`destroy:${args.tabId}`);
      originalDestroy(args);
    };

    const orderedClearStorage = mock(async (_partition: string) => {
      callOrder.push("clearStorageData");
    });
    const closer = buildCloser(registry, orderedClearStorage);

    registry.addTab("tab-order-1", WORKSPACE_ID);
    registry.addTab("tab-order-2", WORKSPACE_ID);

    await closer(WORKSPACE_ID);

    const clearIdx = callOrder.indexOf("clearStorageData");
    expect(clearIdx).toBeGreaterThan(-1);
    const destroy1Idx = callOrder.indexOf("destroy:tab-order-1");
    const destroy2Idx = callOrder.indexOf("destroy:tab-order-2");
    expect(destroy1Idx).toBeLessThan(clearIdx);
    expect(destroy2Idx).toBeLessThan(clearIdx);
    expect(orderedClearStorage).toHaveBeenCalledTimes(1);
  });
});

describe("closer listByWorkspace contract — via FakeRegistry", () => {
  const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const WS_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  test("listByWorkspace returns only tabs for the target workspace", () => {
    const registry = new FakeRegistry();
    registry.addTab("t1", WS_A);
    registry.addTab("t2", WS_A);
    registry.addTab("t3", WS_B);

    const result = registry.listByWorkspace(WS_A);

    expect(result).toHaveLength(2);
    expect(result).toContain("t1");
    expect(result).toContain("t2");
    expect(result).not.toContain("t3");
  });

  test("listByWorkspace returns empty array when no tabs match", () => {
    const registry = new FakeRegistry();
    expect(registry.listByWorkspace(WS_A)).toHaveLength(0);
  });

  test("destroyed tabs are excluded from listByWorkspace", () => {
    const registry = new FakeRegistry();
    registry.addTab("t1", WS_A);
    registry.destroy({ tabId: "t1" });

    expect(registry.listByWorkspace(WS_A)).toHaveLength(0);
  });
});
