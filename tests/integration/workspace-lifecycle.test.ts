/**
 * Integration: WorkspaceManager + GlobalStorage + WorkspaceStorage + StateService.
 *
 * Tests the cross-slice lifecycle: createDefaultIfEmpty → list → update →
 * state.db + workspace.json written → listen.changed broadcast fired →
 * remove → workspace directory still on disk (M0 spec: no auto-delete).
 *
 * Monaco + xterm renderer integration is deferred to T13 (manual scenario).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../src/main/storage/globalStorage";
import { StateService } from "../../src/main/storage/stateService";
import { WorkspaceStorage } from "../../src/main/storage/workspaceStorage";
import { type BroadcastFn, WorkspaceManager } from "../../src/main/workspace/WorkspaceManager";
import type { WorkspaceMeta } from "../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-lifecycle-test-"));
}

function bunSqliteFactory(dbPath: string): Database {
  return new Database(dbPath);
}

interface Fixtures {
  manager: WorkspaceManager;
  globalStorage: GlobalStorage;
  workspaceStorage: WorkspaceStorage;
  stateService: StateService;
  broadcastMock: ReturnType<typeof mock>;
  wsBaseDir: string;
}

function makeFixtures(tmpDir: string): Fixtures {
  const globalDb = new Database(path.join(tmpDir, "global.db"));
  const globalStorage = new GlobalStorage(globalDb);

  const wsBaseDir = path.join(tmpDir, "workspaces");
  fs.mkdirSync(wsBaseDir, { recursive: true });
  const workspaceStorage = new WorkspaceStorage(wsBaseDir, bunSqliteFactory);

  const stateService = new StateService(path.join(tmpDir, "state.json"));
  const broadcastMock = mock((_ch: string, _ev: string, _args: unknown) => {});

  const manager = new WorkspaceManager(
    globalStorage,
    workspaceStorage,
    stateService,
    broadcastMock as BroadcastFn,
  );

  return { manager, globalStorage, workspaceStorage, stateService, broadcastMock, wsBaseDir };
}

// ---------------------------------------------------------------------------
// createDefaultIfEmpty → list 1 workspace
// ---------------------------------------------------------------------------

describe("workspace-lifecycle — createDefaultIfEmpty + list", () => {
  let tmpDir: string;
  let fixtures: Fixtures;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fixtures = makeFixtures(tmpDir);
  });

  afterEach(() => {
    fixtures.globalStorage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("list returns exactly 1 workspace after createDefaultIfEmpty on empty storage", () => {
    const { manager } = fixtures;
    manager.init();
    manager.createDefaultIfEmpty();
    expect(manager.list().length).toBe(1);
  });

  it("createDefaultIfEmpty workspace has os.homedir() as rootPath", () => {
    const { manager } = fixtures;
    manager.init();
    manager.createDefaultIfEmpty();
    expect(manager.list()[0].rootPath).toBe(os.homedir());
  });

  it("createDefaultIfEmpty creates per-workspace directory + state.db", () => {
    const { manager, wsBaseDir } = fixtures;
    manager.init();
    manager.createDefaultIfEmpty();

    const wsId = manager.list()[0].id;
    const wsDir = path.join(wsBaseDir, wsId);
    const dbPath = path.join(wsDir, "state.db");

    expect(fs.existsSync(wsDir)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// update → state.db + workspace.json updated + broadcast fired
// ---------------------------------------------------------------------------

describe("workspace-lifecycle — update propagates to storage + broadcast", () => {
  let tmpDir: string;
  let fixtures: Fixtures;
  let wsId: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fixtures = makeFixtures(tmpDir);

    const { manager } = fixtures;
    manager.init();
    manager.createDefaultIfEmpty();
    wsId = manager.list()[0].id;
    fixtures.broadcastMock.mockClear();
  });

  afterEach(() => {
    fixtures.globalStorage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("update returns the updated WorkspaceMeta", () => {
    const updated = fixtures.manager.update(wsId, { name: "renamed" });
    expect(updated.name).toBe("renamed");
    expect(updated.id).toBe(wsId);
  });

  it("update reflects new name in list()", () => {
    fixtures.manager.update(wsId, { name: "renamed" });
    expect(fixtures.manager.list()[0].name).toBe("renamed");
  });

  it("update triggers listen.changed broadcast exactly once", () => {
    fixtures.manager.update(wsId, { name: "renamed" });
    expect(fixtures.broadcastMock).toHaveBeenCalledTimes(1);
    const [ch, ev] = fixtures.broadcastMock.mock.calls[0] as [string, string, WorkspaceMeta];
    expect(ch).toBe("workspace");
    expect(ev).toBe("changed");
  });

  it("update broadcast carries the updated WorkspaceMeta", () => {
    fixtures.manager.update(wsId, { name: "new-name" });
    const [, , args] = fixtures.broadcastMock.mock.calls[0] as [string, string, WorkspaceMeta];
    expect(args.id).toBe(wsId);
    expect(args.name).toBe("new-name");
  });

  it("update writes workspace.json recovery dump in workspace directory", () => {
    fixtures.manager.update(wsId, { name: "dump-check" });

    const wsDir = path.join(fixtures.wsBaseDir, wsId);
    const jsonPath = path.join(wsDir, "workspace.json");
    expect(fs.existsSync(jsonPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as WorkspaceMeta;
    expect(parsed.id).toBe(wsId);
    expect(parsed.name).toBe("dump-check");
  });

  it("update persists to globalStorage (in-process read-back)", () => {
    fixtures.manager.update(wsId, { name: "persisted-name" });

    const rows = fixtures.globalStorage.listWorkspaces();
    expect(rows.find((w) => w.id === wsId)?.name).toBe("persisted-name");
  });
});

// ---------------------------------------------------------------------------
// remove → directory remains on disk (M0 spec: no auto-delete)
// ---------------------------------------------------------------------------

describe("workspace-lifecycle — remove keeps directory on disk (M0 spec)", () => {
  let tmpDir: string;
  let fixtures: Fixtures;
  let wsId: string;
  let wsDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fixtures = makeFixtures(tmpDir);

    const { manager, wsBaseDir } = fixtures;
    manager.init();
    manager.createDefaultIfEmpty();
    wsId = manager.list()[0].id;
    wsDir = path.join(wsBaseDir, wsId);
    fixtures.broadcastMock.mockClear();
  });

  afterEach(() => {
    fixtures.globalStorage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("remove removes workspace from list()", () => {
    fixtures.manager.remove(wsId);
    expect(fixtures.manager.list().length).toBe(0);
  });

  it("remove keeps workspace directory on disk (M0: no auto-delete)", () => {
    expect(fs.existsSync(wsDir)).toBe(true);
    fixtures.manager.remove(wsId);
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("remove fires listen.changed broadcast", () => {
    fixtures.manager.remove(wsId);
    expect(fixtures.broadcastMock).toHaveBeenCalledTimes(1);
    const [ch, ev] = fixtures.broadcastMock.mock.calls[0] as [string, string, unknown];
    expect(ch).toBe("workspace");
    expect(ev).toBe("changed");
  });

  it("remove clears active workspace ID when the active workspace is removed", () => {
    fixtures.manager.activate(wsId);
    fixtures.manager.remove(wsId);
    expect(fixtures.manager.getActiveId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle: create → update → state.db → remove → dir survives
// ---------------------------------------------------------------------------

describe("workspace-lifecycle — full scenario (create → update → remove)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("end-to-end: single workspace goes through create → update → remove with all invariants", () => {
    const { manager, globalStorage, stateService, wsBaseDir, broadcastMock } = makeFixtures(tmpDir);

    manager.init();
    manager.createDefaultIfEmpty();

    const list1 = manager.list();
    expect(list1.length).toBe(1);

    const ws = list1[0];
    expect(stateService.getState().lastActiveWorkspaceId).toBe(ws.id);

    // Update
    broadcastMock.mockClear();
    manager.update(ws.id, { name: "integration-renamed", pinned: true });

    expect(manager.list()[0].name).toBe("integration-renamed");
    expect(manager.list()[0].pinned).toBe(true);
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    // workspace.json must reflect update
    const jsonPath = path.join(wsBaseDir, ws.id, "workspace.json");
    const dumped = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as WorkspaceMeta;
    expect(dumped.name).toBe("integration-renamed");

    // GlobalStorage must reflect update
    const storedRows = globalStorage.listWorkspaces();
    expect(storedRows[0].name).toBe("integration-renamed");

    const wsDir = path.join(wsBaseDir, ws.id);

    // Remove
    broadcastMock.mockClear();
    manager.remove(ws.id);

    expect(manager.list().length).toBe(0);
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    // Directory must still exist (M0 spec)
    expect(fs.existsSync(wsDir)).toBe(true);

    globalStorage.close();
  });
});
