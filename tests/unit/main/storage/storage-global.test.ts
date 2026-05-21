import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../../../src/main/infra/storage/global-storage";
import { applyMigrations, MIGRATIONS } from "../../../../src/main/infra/storage/migrations";
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
    expect(row?.value).toBe("6");
    db.close();
  });

  it("is idempotent — calling applyMigrations twice yields the same state", () => {
    const db = makeDb();
    applyMigrations(db);
    applyMigrations(db); // second call must not throw or change schemaVersion

    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("6");

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

// ---------------------------------------------------------------------------
// Migration v6: sort_order / pinned_sort_order backfill
// ---------------------------------------------------------------------------

/**
 * Build a DB at v5 by running production migrations v1–v5, then insert
 * workspace rows directly so we can control last_opened_at and pinned values
 * to verify the backfill logic precisely.
 */
function buildPreV6Db(
  workspaces: Array<{
    id: string;
    pinned: number;
    last_opened_at: number;
  }>,
): Database {
  const db = makeDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  let current = 0;
  for (const migration of MIGRATIONS) {
    if (migration.version > 5) break;
    migration.up(db);
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schemaVersion', ?)").run(
      String(migration.version),
    );
    current = migration.version;
  }

  if (current !== 5) {
    throw new Error(`buildPreV6Db: expected to reach schema v5, got v${current}`);
  }

  const insert = db.prepare(
    `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at)
     VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', ?, ?)`,
  );
  for (const ws of workspaces) {
    insert.run(ws.id, ws.pinned, ws.last_opened_at);
  }

  return db;
}

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

describe("migration v6: sort_order and pinned_sort_order backfill", () => {
  it("backfills pinned and unpinned groups with step-1024 positions after v5→v6", () => {
    // 2 pinned (most-recently opened first) + 3 unpinned
    const db = buildPreV6Db([
      { id: uuid(1), pinned: 1, last_opened_at: 5000 }, // pinned, newest
      { id: uuid(2), pinned: 1, last_opened_at: 4000 }, // pinned, older
      { id: uuid(3), pinned: 0, last_opened_at: 3000 }, // unpinned, newest
      { id: uuid(4), pinned: 0, last_opened_at: 2000 },
      { id: uuid(5), pinned: 0, last_opened_at: 1000 }, // unpinned, oldest
    ]);

    applyMigrations(db);

    type SortRow = { id: string; sort_order: number; pinned_sort_order: number; pinned: number };
    const rows = db
      .prepare(
        "SELECT id, sort_order, pinned_sort_order, pinned FROM workspaces ORDER BY last_opened_at DESC",
      )
      .all() as SortRow[];

    // Pinned group: uuid(1) gets 1024, uuid(2) gets 2048
    const pinned = rows.filter((r) => r.pinned === 1);
    expect(pinned[0].id).toBe(uuid(1));
    expect(pinned[0].pinned_sort_order).toBe(1024);
    expect(pinned[0].sort_order).toBe(0); // unpinned column untouched
    expect(pinned[1].id).toBe(uuid(2));
    expect(pinned[1].pinned_sort_order).toBe(2048);

    // Unpinned group: uuid(3) gets 1024, uuid(4) gets 2048, uuid(5) gets 3072
    const unpinned = rows.filter((r) => r.pinned === 0);
    expect(unpinned[0].id).toBe(uuid(3));
    expect(unpinned[0].sort_order).toBe(1024);
    expect(unpinned[0].pinned_sort_order).toBe(0); // pinned column untouched
    expect(unpinned[1].sort_order).toBe(2048);
    expect(unpinned[2].sort_order).toBe(3072);

    db.close();
  });

  it("v6 on an empty DB is a noop — no rows to backfill", () => {
    const db = buildPreV6Db([]);
    expect(() => applyMigrations(db)).not.toThrow();
    const count = (
      db.prepare("SELECT COUNT(*) AS cnt FROM workspaces").get() as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
    db.close();
  });

  it("v6 migration replay is a noop — non-zero positions are not overwritten", () => {
    const db = buildPreV6Db([
      { id: uuid(1), pinned: 0, last_opened_at: 2000 },
      { id: uuid(2), pinned: 0, last_opened_at: 1000 },
    ]);

    applyMigrations(db); // first run: assigns positions

    const afterFirst = db
      .prepare("SELECT id, sort_order FROM workspaces ORDER BY last_opened_at DESC")
      .all() as { id: string; sort_order: number }[];
    expect(afterFirst[0].sort_order).toBe(1024);
    expect(afterFirst[1].sort_order).toBe(2048);

    applyMigrations(db); // second run: must not change positions

    const afterSecond = db
      .prepare("SELECT id, sort_order FROM workspaces ORDER BY last_opened_at DESC")
      .all() as { id: string; sort_order: number }[];
    expect(afterSecond[0].sort_order).toBe(1024);
    expect(afterSecond[1].sort_order).toBe(2048);

    db.close();
  });

  it("idx_workspaces_order index is created by v6", () => {
    const db = buildPreV6Db([]);
    applyMigrations(db);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workspaces'",
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("idx_workspaces_order");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// listWorkspaces sort order
// ---------------------------------------------------------------------------

describe("GlobalStorage.listWorkspaces sort order", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("pinned workspaces appear before unpinned workspaces", () => {
    // Insert via DB directly so we can set sort positions precisely.
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', ?, ?, ?, ?)`,
    ).run(uuid(10), 0, 1000, 1024, 0); // unpinned
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', ?, ?, ?, ?)`,
    ).run(uuid(20), 1, 2000, 0, 1024); // pinned

    const list = storage.listWorkspaces();
    expect(list[0].id).toBe(uuid(20)); // pinned first
    expect(list[1].id).toBe(uuid(10)); // unpinned second
  });

  it("within the same group, workspaces are ordered by sort position ascending", () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, ?, ?, 0)`,
    ).run(uuid(1), 1000, 3072);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, ?, ?, 0)`,
    ).run(uuid(2), 2000, 1024);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, ?, ?, 0)`,
    ).run(uuid(3), 3000, 2048);

    const list = storage.listWorkspaces();
    // sort_order ASC: 1024 < 2048 < 3072
    expect(list[0].id).toBe(uuid(2));
    expect(list[1].id).toBe(uuid(3));
    expect(list[2].id).toBe(uuid(1));
  });

  it("pinned group uses pinned_sort_order for its internal ordering", () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 1, ?, 0, ?)`,
    ).run(uuid(1), 1000, 3072);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 1, ?, 0, ?)`,
    ).run(uuid(2), 2000, 1024);

    const list = storage.listWorkspaces();
    // pinned_sort_order ASC: 1024 < 3072
    expect(list[0].id).toBe(uuid(2));
    expect(list[1].id).toBe(uuid(1));
  });
});

// ---------------------------------------------------------------------------
// computeInsertPosition
// ---------------------------------------------------------------------------

describe("GlobalStorage.computeInsertPosition", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Insert a workspace row with explicit sort positions via the raw DB handle
   * so tests can set up precise ordering scenarios without going through the
   * higher-level addWorkspace API.
   */
  function insertWs(id: string, pinned: 0 | 1, sortOrder: number, pinnedSortOrder: number): void {
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', ?, 1000, ?, ?)`,
    ).run(id, pinned, sortOrder, pinnedSortOrder);
  }

  it("returns tail position (1024) for an empty group", () => {
    const result = storage.computeInsertPosition({ groupKind: "unpinned" });
    expect(result).toEqual({ position: 1024 });
  });

  it("returns tail position (max + 1024) when no reference id is given", () => {
    insertWs(uuid(1), 0, 2048, 0);
    const result = storage.computeInsertPosition({ groupKind: "unpinned" });
    expect(result).toEqual({ position: 3072 });
  });

  it("beforeId: midpoint between the row's predecessor and itself", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 3072, 0);
    // Insert BEFORE uuid(2): midpoint of uuid(1)=1024 and uuid(2)=3072 = 2048
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(2) });
    expect(result).toEqual({ position: 2048 });
  });

  it("afterId: midpoint between the row and its successor", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 3072, 0);
    // Insert AFTER uuid(1): midpoint of uuid(1)=1024 and uuid(2)=3072 = 2048
    const result = storage.computeInsertPosition({ groupKind: "unpinned", afterId: uuid(1) });
    expect(result).toEqual({ position: 2048 });
  });

  it("beforeId on the first row of the group: floor(pos/2)", () => {
    insertWs(uuid(1), 0, 2048, 0);
    insertWs(uuid(2), 0, 3072, 0);
    // Insert BEFORE uuid(1): no predecessor → floor(2048/2) = 1024
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(1) });
    expect(result).toEqual({ position: 1024 });
  });

  it("beforeId on the first row with default step preserves room above", () => {
    insertWs(uuid(1), 0, 1024, 0);
    // floor(1024/2) = 512 — fits between implicit 0 and the existing first row.
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(1) });
    expect(result).toEqual({ position: 512 });
  });

  it("afterId on the last row of the group: pos + 1024", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 2048, 0);
    // Insert AFTER uuid(2): no successor → 2048 + 1024 = 3072
    const result = storage.computeInsertPosition({ groupKind: "unpinned", afterId: uuid(2) });
    expect(result).toEqual({ position: 3072 });
  });

  it("signals rebalance when neighbours collapse to gap < 2 (beforeId path)", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 1025, 0); // gap between predecessor and uuid(2) = 1
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(2) });
    expect(result).toEqual({ rebalance: true });
  });

  it("signals rebalance when neighbours collapse to gap < 2 (afterId path)", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 1025, 0); // gap between uuid(1) and successor = 1
    const result = storage.computeInsertPosition({ groupKind: "unpinned", afterId: uuid(1) });
    expect(result).toEqual({ rebalance: true });
  });

  it("signals rebalance when beforeId is first row and pos − 1024 would underflow", () => {
    insertWs(uuid(1), 0, 1, 0); // first row at the bottom of the range
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(1) });
    expect(result).toEqual({ rebalance: true });
  });

  it("throws when both beforeId and afterId are provided", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 2048, 0);
    expect(() =>
      storage.computeInsertPosition({
        groupKind: "unpinned",
        beforeId: uuid(1),
        afterId: uuid(2),
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// rebalanceGroup
// ---------------------------------------------------------------------------

describe("GlobalStorage.rebalanceGroup", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("reassigns step-1024 positions and returns new values for all rows in the group", () => {
    // Insert rows with collapsed positions to simulate a rebalance scenario.
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, 1000, ?, 0)`,
    ).run(uuid(1), 100);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, 2000, ?, 0)`,
    ).run(uuid(2), 101);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, 3000, ?, 0)`,
    ).run(uuid(3), 102);

    const results = storage.rebalanceGroup("unpinned");

    // Return value: three rows with new step-1024 positions.
    expect(results.length).toBe(3);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId[uuid(1)].sortOrder).toBe(1024);
    expect(byId[uuid(2)].sortOrder).toBe(2048);
    expect(byId[uuid(3)].sortOrder).toBe(3072);

    // Persisted values match the return value.
    const dbRows = db
      .prepare("SELECT id, sort_order FROM workspaces ORDER BY sort_order ASC")
      .all() as { id: string; sort_order: number }[];
    expect(dbRows[0].sort_order).toBe(1024);
    expect(dbRows[1].sort_order).toBe(2048);
    expect(dbRows[2].sort_order).toBe(3072);
  });
});
