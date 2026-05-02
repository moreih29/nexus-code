import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../src/main/storage/globalStorage";
import { applyMigrations } from "../../src/main/storage/migrations";
import type { WorkspaceMeta } from "../../src/shared/types/workspace";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  return new Database(":memory:");
}

function makeMeta(overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "test-workspace",
    rootPath: path.join(os.tmpdir(), "test"),
    colorTone: "default",
    pinned: false,
    lastOpenedAt: new Date(1_700_000_000_000).toISOString(),
    tabs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Migration tests
// ---------------------------------------------------------------------------

describe("applyMigrations", () => {
  it("creates _meta and workspaces tables on fresh DB", () => {
    const db = makeDb();
    applyMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((r) => r.name);
    expect(names).toContain("_meta");
    expect(names).toContain("workspaces");
    db.close();
  });

  it("advances schemaVersion to the latest migration", () => {
    const db = makeDb();
    applyMigrations(db);

    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("2");
    db.close();
  });

  it("is idempotent — calling applyMigrations twice yields the same state", () => {
    const db = makeDb();
    applyMigrations(db);
    applyMigrations(db); // second call must not throw or change schemaVersion

    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("2");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.filter((t) => t.name === "workspaces").length).toBe(1);
    db.close();
  });

  it("v2 drops the unused `category` column", () => {
    const db = makeDb();
    applyMigrations(db);

    const cols = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain("category");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// GlobalStorage: addWorkspace / listWorkspaces / updateWorkspace / removeWorkspace
// ---------------------------------------------------------------------------

describe("GlobalStorage.addWorkspace / listWorkspaces", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("addWorkspace inserts exactly 1 row and listWorkspaces returns it", () => {
    const meta = makeMeta();
    storage.addWorkspace(meta);
    const list = storage.listWorkspaces();
    expect(list.length).toBe(1);
    const row = list[0];
    expect(row.id).toBe(meta.id);
    expect(row.name).toBe(meta.name);
    expect(row.rootPath).toBe(meta.rootPath);
    expect(row.colorTone).toBe(meta.colorTone);
    expect(row.pinned).toBe(false);
  });

  it("column mapping is accurate — pinned integer round-trips to boolean", () => {
    storage.addWorkspace(makeMeta({ pinned: true }));
    const list = storage.listWorkspaces();
    expect(list[0].pinned).toBe(true);
  });

  it("listWorkspaces returns empty array when no workspaces exist", () => {
    expect(storage.listWorkspaces()).toEqual([]);
  });

  it("addWorkspace stores multiple workspaces", () => {
    storage.addWorkspace(makeMeta({ id: "00000000-0000-0000-0000-000000000001" }));
    storage.addWorkspace(
      makeMeta({
        id: "00000000-0000-0000-0000-000000000002",
        name: "second",
        lastOpenedAt: new Date(1_700_000_001_000).toISOString(),
      }),
    );
    expect(storage.listWorkspaces().length).toBe(2);
  });
});

describe("GlobalStorage.updateWorkspace", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
    storage.addWorkspace(makeMeta());
  });

  afterEach(() => {
    db.close();
  });

  it("updates name field", () => {
    storage.updateWorkspace("00000000-0000-0000-0000-000000000001", {
      name: "renamed",
    });
    const list = storage.listWorkspaces();
    expect(list[0].name).toBe("renamed");
  });

  it("throws when workspace is not found", () => {
    expect(() =>
      storage.updateWorkspace("00000000-0000-0000-0000-000000000099", {
        name: "x",
      }),
    ).toThrow("workspace not found");
  });
});

describe("GlobalStorage.removeWorkspace", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
    storage.addWorkspace(makeMeta());
  });

  afterEach(() => {
    db.close();
  });

  it("removes the workspace row", () => {
    storage.removeWorkspace("00000000-0000-0000-0000-000000000001");
    expect(storage.listWorkspaces().length).toBe(0);
  });

  it("is a no-op when the workspace does not exist", () => {
    storage.removeWorkspace("00000000-0000-0000-0000-000000000099");
    expect(storage.listWorkspaces().length).toBe(1);
  });
});
