import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../../../src/main/infra/storage/global-storage";
import { applyMigrations } from "../../../../src/main/infra/storage/migrations";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";

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
    location: { kind: "local", rootPath: path.join(os.tmpdir(), "test") },
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
    expect(row?.value).toBe("5");
    db.close();
  });

  it("is idempotent — calling applyMigrations twice yields the same state", () => {
    const db = makeDb();
    applyMigrations(db);
    applyMigrations(db); // second call must not throw or change schemaVersion

    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("5");

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

  it("v3 adds the workspace location column", () => {
    const db = makeDb();
    applyMigrations(db);

    const cols = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("location");
    db.close();
  });

  it("v3 backfills legacy rows with local locations", () => {
    const db = makeDb();
    db.exec(`
      CREATE TABLE _meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE workspaces (
        id             TEXT NOT NULL PRIMARY KEY,
        name           TEXT NOT NULL,
        root_path      TEXT NOT NULL,
        color_tone     TEXT NOT NULL DEFAULT 'default',
        pinned         INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT INTO _meta (key, value) VALUES ('schemaVersion', '2')").run();
    db.prepare(
      `INSERT INTO workspaces
         (id, name, root_path, color_tone, pinned, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "00000000-0000-0000-0000-000000000099",
      "legacy",
      "/legacy/root",
      "default",
      0,
      1_700_000_000_000,
    );

    applyMigrations(db);
    applyMigrations(db);

    const row = db.prepare("SELECT root_path, location FROM workspaces").get() as {
      root_path: string;
      location: string;
    };
    expect(row.root_path).toBe("/legacy/root");
    expect(JSON.parse(row.location)).toEqual({ kind: "local", rootPath: "/legacy/root" });
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
    expect(row.location).toEqual(meta.location);
    expect(row.colorTone).toBe(meta.colorTone);
    expect(row.pinned).toBe(false);
  });

  it("addWorkspace persists ssh location and remotePath compatibility rootPath", () => {
    const meta = makeMeta({
      rootPath: "/srv/app",
      location: { kind: "ssh", host: "devbox", remotePath: "/srv/app", configAlias: "dev" },
    });
    storage.addWorkspace(meta);

    const row = storage.listWorkspaces()[0];
    expect(row.location).toEqual({ ...meta.location, authMode: "interactive" });
    expect(row.rootPath).toBe("/srv/app");
  });

  it("loads legacy ssh locations without authMode as interactive", () => {
    db.prepare(
      `INSERT INTO workspaces
         (id, name, root_path, location, color_tone, pinned, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "00000000-0000-0000-0000-000000000099",
      "legacy-ssh",
      "/srv/legacy",
      JSON.stringify({ kind: "ssh", host: "legacy", remotePath: "/srv/legacy" }),
      "default",
      0,
      1_700_000_000_000,
    );

    const row = storage.listWorkspaces()[0];
    expect(row.location).toEqual({
      kind: "ssh",
      host: "legacy",
      remotePath: "/srv/legacy",
      authMode: "interactive",
    });
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

  it("updates location and keeps rootPath compatibility in sync", () => {
    storage.updateWorkspace("00000000-0000-0000-0000-000000000001", {
      location: { kind: "ssh", host: "remote", remotePath: "/work/repo" },
    });
    const list = storage.listWorkspaces();
    expect(list[0].location).toEqual({
      kind: "ssh",
      host: "remote",
      remotePath: "/work/repo",
      authMode: "interactive",
    });
    expect(list[0].rootPath).toBe("/work/repo");
  });

  it("fills legacy ssh authMode when a workspace row is updated", () => {
    db.prepare("UPDATE workspaces SET location = ? WHERE id = ?").run(
      JSON.stringify({ kind: "ssh", host: "legacy", remotePath: "/srv/legacy" }),
      "00000000-0000-0000-0000-000000000001",
    );

    storage.updateWorkspace("00000000-0000-0000-0000-000000000001", { name: "renamed" });

    const raw = db.prepare("SELECT location FROM workspaces WHERE id = ?").get(
      "00000000-0000-0000-0000-000000000001",
    ) as { location: string };
    expect(JSON.parse(raw.location)).toEqual({
      kind: "ssh",
      host: "legacy",
      remotePath: "/srv/legacy",
      authMode: "interactive",
    });
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
