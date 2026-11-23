import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalStorage } from "../../../../../src/main/infra/storage/global-storage";
import { applyMigrations, MIGRATIONS } from "../../../../../src/main/infra/storage/migrations";

function makeDb(): Database {
  return new Database(":memory:");
}

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function buildPreV5Db(): Database {
  const db = makeDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  let current = 0;
  for (const migration of MIGRATIONS) {
    if (migration.version > 4) break;
    migration.up(db);
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schemaVersion', ?)").run(
      String(migration.version),
    );
    current = migration.version;
  }

  if (current !== 4) {
    throw new Error(`buildPreV5Db: expected to reach schema v4, got v${current}`);
  }

  return db;
}

describe("AC-1: v5 migration on DB with pre-existing local bookmarks", () => {
  it("all pre-existing rows are backfilled to kind='local'", () => {
    const db = buildPreV5Db();
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO folder_bookmarks (id, abs_path, label, favorite, last_used_at, created_at)
         VALUES (?, ?, NULL, 0, ?, ?)`,
      ).run(uuid(i), `/home/user/project${i}`, i * 1000, i * 1000);
    }

    applyMigrations(db);

    const rows = db
      .prepare("SELECT id, abs_path, kind FROM folder_bookmarks ORDER BY abs_path")
      .all() as { id: string; abs_path: string; kind: string }[];

    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.kind).toBe("local");
    }
    db.close();
  });

  it("data (id, abs_path, label, favorite, last_used_at, created_at) is unchanged after v5", () => {
    const db = buildPreV5Db();
    const now = Date.now();
    db.prepare(
      `INSERT INTO folder_bookmarks (id, abs_path, label, favorite, last_used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(uuid(1), "/home/user/myproject", "My Project", 1, now, now - 100);

    applyMigrations(db);

    const row = db.prepare("SELECT * FROM folder_bookmarks WHERE id = ?").get(uuid(1)) as {
      id: string;
      abs_path: string;
      label: string;
      favorite: number;
      last_used_at: number;
      created_at: number;
      kind: string;
      connection_profile_id: string | null;
    };

    expect(row.id).toBe(uuid(1));
    expect(row.abs_path).toBe("/home/user/myproject");
    expect(row.label).toBe("My Project");
    expect(row.favorite).toBe(1);
    expect(row.last_used_at).toBe(now);
    expect(row.created_at).toBe(now - 100);
    expect(row.kind).toBe("local");
    expect(row.connection_profile_id).toBeNull();

    db.close();
  });

  it("v5 migration is idempotent on the v4 database with existing rows", () => {
    const db = buildPreV5Db();
    for (let i = 1; i <= 2; i++) {
      db.prepare(
        `INSERT INTO folder_bookmarks (id, abs_path, label, favorite, last_used_at, created_at)
         VALUES (?, ?, NULL, 0, ?, ?)`,
      ).run(uuid(i), `/home/user/path${i}`, i * 1000, i * 1000);
    }

    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM folder_bookmarks").get() as {
      cnt: number;
    };
    expect(rows.cnt).toBe(2);

    db.close();
  });
});

describe("AC-2: orphan ssh bookmark — excluded from list and eviction cap", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("ssh bookmark disappears from listFolderBookmarks after its profile is deleted", () => {
    storage.recordConnectionProfile({ id: uuid(100), host: "devbox", user: "alice", port: 22 });

    storage.recordFolderBookmark({
      id: uuid(1),
      absPath: "/remote/project",
      kind: "ssh",
      connectionProfileId: uuid(100),
    });

    const before = storage.listFolderBookmarks();
    expect(before.some((b) => b.id === uuid(1))).toBe(true);

    storage.removeConnectionProfile(uuid(100));

    const after = storage.listFolderBookmarks();
    expect(after.some((b) => b.id === uuid(1))).toBe(false);
  });

  it("orphan ssh row does NOT consume an eviction cap slot", () => {
    storage.recordConnectionProfile({ id: uuid(100), host: "ghost", user: "alice", port: 22 });
    storage.recordFolderBookmark({
      id: uuid(1),
      absPath: "/remote/ghost",
      kind: "ssh",
      connectionProfileId: uuid(100),
    });

    storage.removeConnectionProfile(uuid(100));

    for (let i = 2; i <= 21; i++) {
      storage.recordFolderBookmark({ id: uuid(i), absPath: `/local/path${i}` });
    }

    const list = storage.listFolderBookmarks();

    const nonFavCount = list.filter((b) => !b.favorite).length;
    expect(nonFavCount).toBe(20);

    expect(list.some((b) => b.id === uuid(1))).toBe(false);

    for (const b of list) {
      expect(b.kind).toBe("local");
    }
  });

  it("only the orphan ssh bookmark is hidden; other bookmarks (local and valid ssh) remain", () => {
    storage.recordConnectionProfile({ id: uuid(200), host: "valid-server", user: "bob", port: 22 });
    storage.recordFolderBookmark({
      id: uuid(10),
      absPath: "/remote/valid",
      kind: "ssh",
      connectionProfileId: uuid(200),
    });

    storage.recordConnectionProfile({
      id: uuid(300),
      host: "deleted-server",
      user: "alice",
      port: 22,
    });
    storage.recordFolderBookmark({
      id: uuid(20),
      absPath: "/remote/deleted",
      kind: "ssh",
      connectionProfileId: uuid(300),
    });

    storage.recordFolderBookmark({ id: uuid(30), absPath: "/local/project" });

    storage.removeConnectionProfile(uuid(300));

    const list = storage.listFolderBookmarks();

    expect(list.some((b) => b.id === uuid(10))).toBe(true);
    expect(list.some((b) => b.id === uuid(30))).toBe(true);
    expect(list.some((b) => b.id === uuid(20))).toBe(false);
  });
});

describe("AC-3: ssh upsert via partial UNIQUE and local backward compat", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("ssh bookmark insert does not throw (no PK violation)", () => {
    storage.recordConnectionProfile({ id: uuid(100), host: "devbox", user: "alice", port: 22 });

    expect(() =>
      storage.recordFolderBookmark({
        id: uuid(1),
        absPath: "/remote/project",
        kind: "ssh",
        connectionProfileId: uuid(100),
      }),
    ).not.toThrow();
  });

  it("ssh bookmark re-insert with same (connectionProfileId, absPath) upserts without PK violation", () => {
    storage.recordConnectionProfile({ id: uuid(100), host: "devbox", user: "alice", port: 22 });

    storage.recordFolderBookmark({
      id: uuid(1),
      absPath: "/remote/project",
      kind: "ssh",
      connectionProfileId: uuid(100),
    });

    expect(() =>
      storage.recordFolderBookmark({
        id: uuid(2),
        absPath: "/remote/project",
        kind: "ssh",
        connectionProfileId: uuid(100),
      }),
    ).not.toThrow();

    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM folder_bookmarks WHERE kind = 'ssh'")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it("same abs_path but different connectionProfileId produces two distinct ssh rows", () => {
    storage.recordConnectionProfile({ id: uuid(100), host: "server-a", user: "alice", port: 22 });
    storage.recordConnectionProfile({ id: uuid(200), host: "server-b", user: "bob", port: 22 });

    storage.recordFolderBookmark({
      id: uuid(1),
      absPath: "/remote/shared",
      kind: "ssh",
      connectionProfileId: uuid(100),
    });
    storage.recordFolderBookmark({
      id: uuid(2),
      absPath: "/remote/shared",
      kind: "ssh",
      connectionProfileId: uuid(200),
    });

    const rows = db
      .prepare("SELECT COUNT(*) as cnt FROM folder_bookmarks WHERE kind = 'ssh'")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(2);
  });

  it("local bookmark with same abs_path as an ssh bookmark does not conflict", () => {
    storage.recordConnectionProfile({ id: uuid(100), host: "devbox", user: "alice", port: 22 });

    storage.recordFolderBookmark({
      id: uuid(1),
      absPath: "/shared/path",
      kind: "ssh",
      connectionProfileId: uuid(100),
    });

    expect(() =>
      storage.recordFolderBookmark({
        id: uuid(2),
        absPath: "/shared/path",
      }),
    ).not.toThrow();

    const rows = db.prepare("SELECT kind FROM folder_bookmarks ORDER BY kind").all() as {
      kind: string;
    }[];
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["local", "ssh"]);
  });

  it("local record call WITHOUT kind field continues to work (backward compat)", () => {
    expect(() =>
      storage.recordFolderBookmark({
        id: uuid(1),
        absPath: "/home/user/project",
      }),
    ).not.toThrow();

    const list = storage.listFolderBookmarks();
    expect(list.length).toBe(1);
    expect(list[0].kind).toBe("local");
  });

  it("local record call WITHOUT kind field upserts without PK violation on repeated call", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/home/user/project" });
    expect(() =>
      storage.recordFolderBookmark({ id: uuid(2), absPath: "/home/user/project" }),
    ).not.toThrow();

    const rows = db.prepare("SELECT COUNT(*) as cnt FROM folder_bookmarks").get() as {
      cnt: number;
    };
    expect(rows.cnt).toBe(1);
  });
});
