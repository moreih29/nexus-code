/**
 * Integration: storage persistence across simulated restart.
 *
 * Uses real temporary SQLite files (not in-memory) backed by bun:sqlite so the
 * test verifies that GlobalStorage + StateService survive a close/re-open cycle
 * without data loss — the scenario that an in-memory DB cannot exercise.
 *
 * Monaco + xterm renderer integration is deferred to T13 (manual scenario).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../src/main/storage/globalStorage";
import { StateService } from "../../src/main/storage/stateService";
import { WorkspaceStorage } from "../../src/main/storage/workspaceStorage";
import type { WorkspaceMeta } from "../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-restart-test-"));
}

function bunSqliteFactory(dbPath: string): Database {
  return new Database(dbPath);
}

function openGlobalStorage(dbPath: string): GlobalStorage {
  const db = new Database(dbPath);
  return new GlobalStorage(db);
}

function makeMeta(id: string, rootPath: string): WorkspaceMeta {
  return {
    id,
    name: path.basename(rootPath),
    rootPath,
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

// ---------------------------------------------------------------------------
// storage-restart: GlobalStorage persists workspace across close/re-open
// ---------------------------------------------------------------------------

describe("storage-restart — GlobalStorage round-trip on real SQLite file", () => {
  let tmpDir: string;
  let globalDbPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    globalDbPath = path.join(tmpDir, "state.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("workspace added in session 1 is visible in session 2", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const rootPath = path.join(os.tmpdir(), "my-project");

    // Session 1 — add workspace then close.
    const storage1 = openGlobalStorage(globalDbPath);
    storage1.addWorkspace(makeMeta(id, rootPath));
    storage1.close();

    // Session 2 — open the same file and list.
    const storage2 = openGlobalStorage(globalDbPath);
    const list = storage2.listWorkspaces();
    storage2.close();

    expect(list.length).toBe(1);
    expect(list[0].id).toBe(id);
    expect(list[0].rootPath).toBe(rootPath);
  });

  it("workspace update in session 1 is reflected in session 2", () => {
    const id = "00000000-0000-0000-0000-000000000002";

    const storage1 = openGlobalStorage(globalDbPath);
    storage1.addWorkspace(makeMeta(id, path.join(os.tmpdir(), "proj")));
    storage1.updateWorkspace(id, { name: "renamed-in-s1" });
    storage1.close();

    const storage2 = openGlobalStorage(globalDbPath);
    const list = storage2.listWorkspaces();
    storage2.close();

    expect(list[0].name).toBe("renamed-in-s1");
  });

  it("workspace removed in session 1 is absent in session 2", () => {
    const id = "00000000-0000-0000-0000-000000000003";

    const storage1 = openGlobalStorage(globalDbPath);
    storage1.addWorkspace(makeMeta(id, path.join(os.tmpdir(), "to-remove")));
    storage1.removeWorkspace(id);
    storage1.close();

    const storage2 = openGlobalStorage(globalDbPath);
    const list = storage2.listWorkspaces();
    storage2.close();

    expect(list.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// storage-restart: StateService persists lastActiveWorkspaceId
// ---------------------------------------------------------------------------

describe("storage-restart — StateService persists across re-construction", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    statePath = path.join(tmpDir, "state.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lastActiveWorkspaceId written in session 1 is readable in session 2", () => {
    const wsId = "00000000-0000-0000-0000-aabbccddeeff";

    const ss1 = new StateService(statePath);
    ss1.setState({ lastActiveWorkspaceId: wsId });

    const ss2 = new StateService(statePath);
    expect(ss2.getState().lastActiveWorkspaceId).toBe(wsId);
  });
});

// ---------------------------------------------------------------------------
// storage-restart: WorkspaceStorage — per-workspace directory + state.db survive
// ---------------------------------------------------------------------------

describe("storage-restart — WorkspaceStorage directory survives session boundary", () => {
  let tmpDir: string;
  let wsBaseDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    wsBaseDir = path.join(tmpDir, "workspaces");
    fs.mkdirSync(wsBaseDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("workspace directory and state.db created in session 1 exist in session 2", () => {
    const id = "00000000-0000-0000-0000-111122223333";

    // Session 1
    const ws1 = new WorkspaceStorage(wsBaseDir, bunSqliteFactory);
    ws1.openForWorkspace(id);
    ws1.closeForWorkspace(id);

    // Session 2 — construct a new WorkspaceStorage instance over the same dir.
    const ws2 = new WorkspaceStorage(wsBaseDir, bunSqliteFactory);
    ws2.openForWorkspace(id); // must not throw even though dir already exists

    const wsDir = path.join(wsBaseDir, id);
    const dbPath = path.join(wsDir, "state.db");
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    ws2.closeForWorkspace(id);
  });

  it("setMeta in session 1 is readable via workspace.json in session 2", () => {
    const id = "00000000-0000-0000-0000-444455556666";
    const rootPath = path.join(os.tmpdir(), "persisted-ws");
    const meta = makeMeta(id, rootPath);

    const ws1 = new WorkspaceStorage(wsBaseDir, bunSqliteFactory);
    ws1.openForWorkspace(id);
    ws1.setMeta(id, meta);
    ws1.closeForWorkspace(id);

    // Verify the workspace.json recovery dump is readable without SQLite.
    const jsonPath = path.join(wsBaseDir, id, "workspace.json");
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as WorkspaceMeta;
    expect(parsed.id).toBe(id);
    expect(parsed.rootPath).toBe(rootPath);
  });
});

// ---------------------------------------------------------------------------
// storage-restart: Full stateService + globalStorage combo (primary scenario)
// ---------------------------------------------------------------------------

describe("storage-restart — stateService + globalStorage combined restart scenario", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds workspace then restarts — same workspace listed and state preserved", () => {
    const globalDbPath = path.join(tmpDir, "state.db");
    const statePath = path.join(tmpDir, "state.json");
    const wsId = "00000000-0000-0000-0000-cafebabe0001";

    // --- Session 1 ---
    const g1 = openGlobalStorage(globalDbPath);
    const ss1 = new StateService(statePath);
    g1.addWorkspace(makeMeta(wsId, "/projects/nexus"));
    ss1.setState({ lastActiveWorkspaceId: wsId });
    g1.close();

    // --- Session 2 ---
    const g2 = openGlobalStorage(globalDbPath);
    const ss2 = new StateService(statePath);

    const list = g2.listWorkspaces();
    const activeId = ss2.getState().lastActiveWorkspaceId;
    g2.close();

    expect(list.length).toBe(1);
    expect(list[0].id).toBe(wsId);
    expect(activeId).toBe(wsId);
  });
});
