import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { Database } from "bun:sqlite";
import { GlobalStorage } from "../../src/main/storage/globalStorage";
import { WorkspaceStorage } from "../../src/main/storage/workspaceStorage";
import { StateService } from "../../src/main/storage/stateService";
import { WorkspaceManager } from "../../src/main/workspace/WorkspaceManager";
import type { BroadcastFn } from "../../src/main/workspace/WorkspaceManager";

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
  broadcastFn: BroadcastFn
): WorkspaceManager {
  return new WorkspaceManager(globalStorage, workspaceStorage, stateService, broadcastFn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceManager — createDefaultIfEmpty", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates exactly 1 workspace when storage is empty", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } =
      makeFixtures(tmpDir);
    const manager = makeManager(globalStorage, workspaceStorage, stateService, broadcastMock as BroadcastFn);

    manager.init();
    manager.createDefaultIfEmpty();

    const list = manager.list();
    expect(list.length).toBe(1);

    globalStorage.close();
  });

  it("does not create a second workspace when one already exists", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } =
      makeFixtures(tmpDir);
    const manager = makeManager(globalStorage, workspaceStorage, stateService, broadcastMock as BroadcastFn);

    manager.init();
    manager.createDefaultIfEmpty();
    manager.createDefaultIfEmpty(); // second call must be a no-op

    expect(manager.list().length).toBe(1);

    globalStorage.close();
  });

  it("default workspace uses os.homedir() as rootPath", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } =
      makeFixtures(tmpDir);
    const manager = makeManager(globalStorage, workspaceStorage, stateService, broadcastMock as BroadcastFn);

    manager.init();
    manager.createDefaultIfEmpty();

    const ws = manager.list()[0];
    expect(ws.rootPath).toBe(os.homedir());

    globalStorage.close();
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
    mgr1.createDefaultIfEmpty();

    const createdId = mgr1.list()[0].id;
    expect(mgr1.getActiveId()).toBe(createdId);

    // Close the first manager (closes globalStorage1 and ws1 handles).
    mgr1.close();

    // --- Second boot (same files) ---
    const globalStorage2 = openFileGlobalStorage(globalDbPath);
    const ws2 = new WorkspaceStorage(wsBaseDir, bunSqliteFactory);
    const ss2 = new StateService(statePath);
    const bcast2 = mock((_c: string, _e: string, _a: unknown) => {});

    const mgr2 = new WorkspaceManager(globalStorage2, ws2, ss2, bcast2 as BroadcastFn);
    mgr2.init();
    mgr2.createDefaultIfEmpty(); // should be no-op

    expect(mgr2.list().length).toBe(1);
    expect(mgr2.list()[0].id).toBe(createdId);
    expect(mgr2.getActiveId()).toBe(createdId);

    mgr2.close();
  });
});

describe("WorkspaceManager — listen.changed broadcast", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("broadcasts 'changed' event when update is called", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } =
      makeFixtures(tmpDir);
    const manager = makeManager(globalStorage, workspaceStorage, stateService, broadcastMock as BroadcastFn);

    manager.init();
    manager.createDefaultIfEmpty();
    broadcastMock.mockClear();

    const id = manager.list()[0].id;
    manager.update(id, { name: "renamed" });

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [ch, ev, args] = broadcastMock.mock.calls[0] as [string, string, { id: string; name: string }];
    expect(ch).toBe("workspace");
    expect(ev).toBe("changed");
    expect(args.id).toBe(id);
    expect(args.name).toBe("renamed");

    globalStorage.close();
  });

  it("broadcasts 'changed' event when create is called", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } =
      makeFixtures(tmpDir);
    const manager = makeManager(globalStorage, workspaceStorage, stateService, broadcastMock as BroadcastFn);

    manager.init();
    broadcastMock.mockClear();

    manager.create({ rootPath: "/tmp/test-ws", name: "test" });

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [ch, ev] = broadcastMock.mock.calls[0] as [string, string, unknown];
    expect(ch).toBe("workspace");
    expect(ev).toBe("changed");

    globalStorage.close();
  });

  it("broadcasts 'changed' event when remove is called", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } =
      makeFixtures(tmpDir);
    const manager = makeManager(globalStorage, workspaceStorage, stateService, broadcastMock as BroadcastFn);

    manager.init();
    manager.createDefaultIfEmpty();
    broadcastMock.mockClear();

    const id = manager.list()[0].id;
    manager.remove(id);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [ch, ev] = broadcastMock.mock.calls[0] as [string, string, unknown];
    expect(ch).toBe("workspace");
    expect(ev).toBe("changed");

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
    const { globalStorage, workspaceStorage, stateService, broadcastMock } =
      makeFixtures(tmpDir);
    const manager = makeManager(globalStorage, workspaceStorage, stateService, broadcastMock as BroadcastFn);

    manager.init();
    const ws1 = manager.create({ rootPath: "/tmp/ws1", name: "ws1" });
    const ws2 = manager.create({ rootPath: "/tmp/ws2", name: "ws2" });

    manager.activate(ws1.id);
    expect(manager.getActiveId()).toBe(ws1.id);
    expect(stateService.getState().lastActiveWorkspaceId).toBe(ws1.id);

    manager.activate(ws2.id);
    expect(manager.getActiveId()).toBe(ws2.id);
    expect(stateService.getState().lastActiveWorkspaceId).toBe(ws2.id);

    globalStorage.close();
  });

  it("activate throws for unknown workspace id", () => {
    const { globalStorage, workspaceStorage, stateService, broadcastMock } =
      makeFixtures(tmpDir);
    const manager = makeManager(globalStorage, workspaceStorage, stateService, broadcastMock as BroadcastFn);

    manager.init();

    expect(() =>
      manager.activate("00000000-0000-0000-0000-000000000099")
    ).toThrow("workspace not found");

    globalStorage.close();
  });
});
