import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../src/main/storage/globalStorage";
import { StateService } from "../../src/main/storage/stateService";
import { WorkspaceStorage } from "../../src/main/storage/workspaceStorage";
import type { BroadcastFn } from "../../src/main/workspace/WorkspaceManager";
import { WorkspaceManager } from "../../src/main/workspace/WorkspaceManager";

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
): WorkspaceManager {
  return new WorkspaceManager(globalStorage, workspaceStorage, stateService, broadcastFn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceManager — restart simulation (persistence round-trip)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restores the same workspace on second init", () => {
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

    const mgr1 = new WorkspaceManager(globalStorage1, ws1, ss1, bcast1 as BroadcastFn);
    mgr1.init();
    const created = mgr1.create({ rootPath: path.join(tmpDir, "fixture-root"), name: "fixture" });
    mgr1.activate(created.id);

    expect(mgr1.list().length).toBe(1);
    expect(mgr1.getActiveId()).toBe(created.id);

    // Close the first manager (closes globalStorage1 and ws1 handles).
    mgr1.close();

    // --- Second boot (same files) ---
    const globalStorage2 = openFileGlobalStorage(globalDbPath);
    const ws2 = new WorkspaceStorage(wsBaseDir, bunSqliteFactory);
    const ss2 = new StateService(statePath);
    const bcast2 = mock((_c: string, _e: string, _a: unknown) => {});

    const mgr2 = new WorkspaceManager(globalStorage2, ws2, ss2, bcast2 as BroadcastFn);
    mgr2.init();

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

    globalStorage.close();
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

    globalStorage.close();
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

  it("activate updates getActiveId and persists to stateService", () => {
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

    manager.activate(ws1.id);
    expect(manager.getActiveId()).toBe(ws1.id);
    expect(stateService.getState().lastActiveWorkspaceId).toBe(ws1.id);

    manager.activate(ws2.id);
    expect(manager.getActiveId()).toBe(ws2.id);
    expect(stateService.getState().lastActiveWorkspaceId).toBe(ws2.id);

    globalStorage.close();
  });

  it("activate throws for unknown workspace id", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();

    expect(() => manager.activate("00000000-0000-0000-0000-000000000099")).toThrow(
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

  it("clears active id when the only workspace is removed", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } = makeFixtures(tmpDir);
    const manager = makeManager(
      globalStorage,
      workspaceStorage,
      stateService,
      broadcastMock as BroadcastFn,
    );

    manager.init();
    const ws = manager.create({ rootPath: path.join(tmpDir, "ws"), name: "ws" });
    manager.activate(ws.id);

    manager.remove(ws.id);

    expect(manager.getActiveId()).toBeNull();
    expect(stateService.getState().lastActiveWorkspaceId).toBeUndefined();

    globalStorage.close();
  });

  it("falls back to a remaining workspace when the active one is removed", () => {
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
    manager.activate(ws1.id);

    manager.remove(ws1.id);

    expect(manager.getActiveId()).toBe(ws2.id);
    expect(stateService.getState().lastActiveWorkspaceId).toBe(ws2.id);

    globalStorage.close();
  });
});
