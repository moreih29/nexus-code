/**
 * Integration: storage persistence across simulated restart.
 *
 * Uses real temporary SQLite files (not in-memory) backed by bun:sqlite so the
 * test verifies that GlobalStorage + StateService survive a close/re-open cycle
 * without data loss — the scenario that an in-memory DB cannot exercise.
 *
 * Monaco + xterm renderer integration requires a browser-level manual scenario.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../src/main/infra/storage/global-storage";
import { StateService } from "../../src/main/infra/storage/state-service";
import { WorkspaceStorage } from "../../src/main/infra/storage/workspace-storage";
import type { WorkspaceMeta } from "../../src/shared/types/workspace";
import { closeTestDatabases, openTestDatabase } from "../helpers/test-database";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexus-restart-test-"));
}

function bunSqliteFactory(dbPath: string): Database {
  return openTestDatabase(dbPath);
}

function openGlobalStorage(dbPath: string): GlobalStorage {
  const db = openTestDatabase(dbPath);
  return new GlobalStorage(db);
}

function makeMeta(id: string, rootPath: string): WorkspaceMeta {
  return {
    id,
    name: path.basename(rootPath),
    rootPath,
    location: { kind: "local", rootPath },
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date().toISOString(),
    tabs: [],
  };
}

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
    closeTestDatabases();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    closeTestDatabases();
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
