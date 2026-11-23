import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../../../../src/main/infra/storage/global-storage";
import { applyMigrations, MIGRATIONS } from "../../../../../src/main/infra/storage/migrations";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const LATEST_SCHEMA_VERSION = String(MIGRATIONS[MIGRATIONS.length - 1]?.version);

function makeDb(): Database {
  return new Database(":memory:");
}

function makeMeta(overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "test-workspace",
    rootPath: path.join(os.tmpdir(), "test"),
    location: { kind: "local", rootPath: path.join(os.tmpdir(), "test") },
    color: "auto",
    pinned: false,
    lastOpenedAt: new Date(1_700_000_000_000).toISOString(),
    tabs: [],
    ...overrides,
  };
}

describe("applyMigrations", () => {
  it("advances schemaVersion to the latest migration", () => {
    const db = makeDb();
    applyMigrations(db);

    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent — calling applyMigrations twice yields the same state", () => {
    const db = makeDb();
    applyMigrations(db);
    applyMigrations(db);

    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe(LATEST_SCHEMA_VERSION);

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

  it.each([
    "subdued",
    "default",
    "prominent",
    "pinned",
  ])("v10 reads the old %s tone as an automatic color and keeps the tone column", (tone) => {
    const db = makeDb();
    applyMigrations(db);
    db.exec("ALTER TABLE workspaces DROP COLUMN color;");
    db.prepare("UPDATE _meta SET value = '9' WHERE key = 'schemaVersion'").run();
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      "00000000-0000-0000-0000-000000000099",
      "old",
      "/old",
      JSON.stringify({ kind: "local", rootPath: "/old" }),
      tone,
      1_700_000_000_000,
    );

    applyMigrations(db);
    applyMigrations(db);

    const cols = (db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("color");
    expect(cols).toContain("color_tone");
    expect(new GlobalStorage(db).listWorkspaces()[0]?.color).toBe("auto");
    db.close();
  });

  it("v10 leaves room for an older build's insert, which names no color", () => {
    const db = makeDb();
    applyMigrations(db);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at)
       VALUES ('00000000-0000-0000-0000-000000000098', 'older', '/o',
               '{"kind":"local","rootPath":"/o"}', 'default', 0, 1700000000000)`,
    ).run();
    expect(new GlobalStorage(db).listWorkspaces()[0]?.color).toBe("auto");
    db.close();
  });
});

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
         (id, name, root_path, location, color, pinned, last_opened_at)
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

  it.each([
    ["blue", "blue"],
    ["auto", "auto"],
  ] as const)("keeps the color %s it is given", (color, expected) => {
    storage.updateWorkspace("00000000-0000-0000-0000-000000000001", { color: "pink" });
    storage.updateWorkspace("00000000-0000-0000-0000-000000000001", { color });
    expect(storage.listWorkspaces()[0]?.color).toBe(expected);
  });

  it("reads a stored color it does not know as auto", () => {
    db.prepare("UPDATE workspaces SET color = 'prominent'").run();
    expect(storage.listWorkspaces()[0]?.color).toBe("auto");
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

    const raw = db
      .prepare("SELECT location FROM workspaces WHERE id = ?")
      .get("00000000-0000-0000-0000-000000000001") as { location: string };
    expect(JSON.parse(raw.location)).toEqual({
      kind: "ssh",
      host: "legacy",
      remotePath: "/srv/legacy",
      authMode: "interactive",
    });
  });

  it("keeps an ssh location with an unknown optional field as ssh", () => {
    const stored = {
      kind: "ssh",
      host: "devbox",
      user: "deploy",
      remotePath: "/srv/app",
      authMode: "key-only",
      remoteArch: { os: "freebsd", arch: "amd64" },
    };
    db.prepare("UPDATE workspaces SET location = ? WHERE id = ?").run(
      JSON.stringify(stored),
      "00000000-0000-0000-0000-000000000001",
    );

    expect(storage.listWorkspaces()[0].location).toEqual({
      kind: "ssh",
      host: "devbox",
      user: "deploy",
      remotePath: "/srv/app",
      authMode: "key-only",
    });

    storage.updateWorkspace("00000000-0000-0000-0000-000000000001", { name: "renamed" });

    const raw = db
      .prepare("SELECT location FROM workspaces WHERE id = ?")
      .get("00000000-0000-0000-0000-000000000001") as { location: string };
    expect(JSON.parse(raw.location)).toEqual(stored);
  });

  it("does not overwrite an unreadable stored location on update", () => {
    const stored = JSON.stringify({ kind: "ssh", hostname: "renamed-field", remotePath: "/srv" });
    db.prepare("UPDATE workspaces SET location = ? WHERE id = ?").run(
      stored,
      "00000000-0000-0000-0000-000000000001",
    );

    storage.updateWorkspace("00000000-0000-0000-0000-000000000001", { name: "renamed" });

    const raw = db
      .prepare("SELECT location FROM workspaces WHERE id = ?")
      .get("00000000-0000-0000-0000-000000000001") as { location: string };
    expect(raw.location).toBe(stored);
  });
});

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
    const db = buildPreV6Db([
      { id: uuid(1), pinned: 1, last_opened_at: 5000 },
      { id: uuid(2), pinned: 1, last_opened_at: 4000 },
      { id: uuid(3), pinned: 0, last_opened_at: 3000 },
      { id: uuid(4), pinned: 0, last_opened_at: 2000 },
      { id: uuid(5), pinned: 0, last_opened_at: 1000 },
    ]);

    applyMigrations(db);

    type SortRow = { id: string; sort_order: number; pinned_sort_order: number; pinned: number };
    const rows = db
      .prepare(
        "SELECT id, sort_order, pinned_sort_order, pinned FROM workspaces ORDER BY last_opened_at DESC",
      )
      .all() as SortRow[];

    const pinned = rows.filter((r) => r.pinned === 1);
    expect(pinned[0].id).toBe(uuid(1));
    expect(pinned[0].pinned_sort_order).toBe(1024);
    expect(pinned[0].sort_order).toBe(0);
    expect(pinned[1].id).toBe(uuid(2));
    expect(pinned[1].pinned_sort_order).toBe(2048);

    const unpinned = rows.filter((r) => r.pinned === 0);
    expect(unpinned[0].id).toBe(uuid(3));
    expect(unpinned[0].sort_order).toBe(1024);
    expect(unpinned[0].pinned_sort_order).toBe(0);
    expect(unpinned[1].sort_order).toBe(2048);
    expect(unpinned[2].sort_order).toBe(3072);

    db.close();
  });

  it("v6 migration replay is a noop — non-zero positions are not overwritten", () => {
    const db = buildPreV6Db([
      { id: uuid(1), pinned: 0, last_opened_at: 2000 },
      { id: uuid(2), pinned: 0, last_opened_at: 1000 },
    ]);

    applyMigrations(db);

    const afterFirst = db
      .prepare("SELECT id, sort_order FROM workspaces ORDER BY last_opened_at DESC")
      .all() as { id: string; sort_order: number }[];
    expect(afterFirst[0].sort_order).toBe(1024);
    expect(afterFirst[1].sort_order).toBe(2048);

    applyMigrations(db);

    const afterSecond = db
      .prepare("SELECT id, sort_order FROM workspaces ORDER BY last_opened_at DESC")
      .all() as { id: string; sort_order: number }[];
    expect(afterSecond[0].sort_order).toBe(1024);
    expect(afterSecond[1].sort_order).toBe(2048);

    db.close();
  });
});

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
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', ?, ?, ?, ?)`,
    ).run(uuid(10), 0, 1000, 1024, 0);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', ?, ?, ?, ?)`,
    ).run(uuid(20), 1, 2000, 0, 1024);

    const list = storage.listWorkspaces();
    expect(list[0].id).toBe(uuid(20));
    expect(list[1].id).toBe(uuid(10));
  });

  it("within the same group, workspaces are ordered by sort position ascending", () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, ?, ?, 0)`,
    ).run(uuid(1), 1000, 3072);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, ?, ?, 0)`,
    ).run(uuid(2), 2000, 1024);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, ?, ?, 0)`,
    ).run(uuid(3), 3000, 2048);

    const list = storage.listWorkspaces();
    expect(list[0].id).toBe(uuid(2));
    expect(list[1].id).toBe(uuid(3));
    expect(list[2].id).toBe(uuid(1));
  });

  it("pinned group uses pinned_sort_order for its internal ordering", () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 1, ?, 0, ?)`,
    ).run(uuid(1), 1000, 3072);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 1, ?, 0, ?)`,
    ).run(uuid(2), 2000, 1024);

    const list = storage.listWorkspaces();
    expect(list[0].id).toBe(uuid(2));
    expect(list[1].id).toBe(uuid(1));
  });
});

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

  function insertWs(id: string, pinned: 0 | 1, sortOrder: number, pinnedSortOrder: number): void {
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
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
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(2) });
    expect(result).toEqual({ position: 2048 });
  });

  it("afterId: midpoint between the row and its successor", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 3072, 0);
    const result = storage.computeInsertPosition({ groupKind: "unpinned", afterId: uuid(1) });
    expect(result).toEqual({ position: 2048 });
  });

  it("beforeId on the first row of the group: floor(pos/2)", () => {
    insertWs(uuid(1), 0, 2048, 0);
    insertWs(uuid(2), 0, 3072, 0);
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(1) });
    expect(result).toEqual({ position: 1024 });
  });

  it("beforeId on the first row with default step preserves room above", () => {
    insertWs(uuid(1), 0, 1024, 0);
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(1) });
    expect(result).toEqual({ position: 512 });
  });

  it("afterId on the last row of the group: pos + 1024", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 2048, 0);
    const result = storage.computeInsertPosition({ groupKind: "unpinned", afterId: uuid(2) });
    expect(result).toEqual({ position: 3072 });
  });

  it("signals rebalance when neighbours collapse to gap < 2 (beforeId path)", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 1025, 0);
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(2) });
    expect(result).toEqual({ rebalance: true });
  });

  it("signals rebalance when neighbours collapse to gap < 2 (afterId path)", () => {
    insertWs(uuid(1), 0, 1024, 0);
    insertWs(uuid(2), 0, 1025, 0);
    const result = storage.computeInsertPosition({ groupKind: "unpinned", afterId: uuid(1) });
    expect(result).toEqual({ rebalance: true });
  });

  it("signals rebalance when beforeId is first row and pos − 1024 would underflow", () => {
    insertWs(uuid(1), 0, 1, 0);
    const result = storage.computeInsertPosition({ groupKind: "unpinned", beforeId: uuid(1) });
    expect(result).toEqual({ rebalance: true });
  });
});

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
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, 1000, ?, 0)`,
    ).run(uuid(1), 100);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, 2000, ?, 0)`,
    ).run(uuid(2), 101);
    db.prepare(
      `INSERT INTO workspaces (id, name, root_path, location, color, pinned, last_opened_at, sort_order, pinned_sort_order)
       VALUES (?, 'ws', '/root', '{"kind":"local","rootPath":"/root"}', 'default', 0, 3000, ?, 0)`,
    ).run(uuid(3), 102);

    const results = storage.rebalanceGroup("unpinned");

    expect(results.length).toBe(3);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId[uuid(1)].sortOrder).toBe(1024);
    expect(byId[uuid(2)].sortOrder).toBe(2048);
    expect(byId[uuid(3)].sortOrder).toBe(3072);

    const dbRows = db
      .prepare("SELECT id, sort_order FROM workspaces ORDER BY sort_order ASC")
      .all() as { id: string; sort_order: number }[];
    expect(dbRows[0].sort_order).toBe(1024);
    expect(dbRows[1].sort_order).toBe(2048);
    expect(dbRows[2].sort_order).toBe(3072);
  });
});
