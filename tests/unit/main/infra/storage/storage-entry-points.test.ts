import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { GlobalStorage } from "../../../../../src/main/infra/storage/global-storage";
import { applyMigrations } from "../../../../../src/main/infra/storage/migrations";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

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

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

describe("migration v4 — applied on top of existing v3 DB", () => {
  it("applies v4 without error on a v3 database that already has workspaces", () => {
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
        location       TEXT,
        color_tone     TEXT NOT NULL DEFAULT 'default',
        pinned         INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT INTO _meta (key, value) VALUES ('schemaVersion', '3')").run();
    db.prepare(`
      INSERT INTO workspaces (id, name, root_path, location, color_tone, pinned, last_opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "00000000-0000-0000-0000-000000000001",
      "legacy",
      "/legacy",
      null,
      "default",
      0,
      1700000000000,
    );

    expect(() => applyMigrations(db)).not.toThrow();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("folder_bookmarks");
    expect(names).toContain("connection_profiles");

    const ws = db.prepare("SELECT id FROM workspaces").get() as { id: string };
    expect(ws.id).toBe("00000000-0000-0000-0000-000000000001");

    db.close();
  });
});

describe("GlobalStorage.recordFolderBookmark — upsert", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("second call with same abs_path does NOT insert a second row", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/home/user/project" });
    storage.recordFolderBookmark({ id: uuid(2), absPath: "/home/user/project" });
    const list = storage.listFolderBookmarks();
    expect(list.length).toBe(1);
  });

  it("upsert updates last_used_at on conflict", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/home/user/project" });
    const before = storage.listFolderBookmarks()[0].lastUsedAt;

    const oldAt = db
      .prepare("SELECT last_used_at FROM folder_bookmarks WHERE abs_path = ?")
      .get("/home/user/project") as { last_used_at: number };

    db.prepare("UPDATE folder_bookmarks SET last_used_at = ? WHERE abs_path = ?").run(
      oldAt.last_used_at - 1000,
      "/home/user/project",
    );

    storage.recordFolderBookmark({ id: uuid(2), absPath: "/home/user/project" });
    const after = storage.listFolderBookmarks()[0].lastUsedAt;
    expect(after).toBeGreaterThan(before - 1000);
    expect(storage.listFolderBookmarks().length).toBe(1);
  });
});

describe("GlobalStorage.recordFolderBookmark — cap eviction", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("21st non-favorite row evicts the oldest", () => {
    for (let i = 1; i <= 20; i++) {
      db.prepare(
        `INSERT INTO folder_bookmarks (id, abs_path, label, favorite, last_used_at, created_at)
         VALUES (?, ?, NULL, 0, ?, ?)`,
      ).run(uuid(i), `/path/${i}`, i * 1000, i * 1000);
    }
    storage.recordFolderBookmark({ id: uuid(21), absPath: "/path/21" });

    const list = storage.listFolderBookmarks();
    expect(list.length).toBe(20);
    const paths = list.map((b) => b.absPath);
    expect(paths).not.toContain("/path/1");
    expect(paths).toContain("/path/21");
  });

  it("favorite rows are NOT evicted regardless of cap", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/path/fav" });
    storage.setFolderBookmarkFavorite(uuid(1), true);

    for (let i = 2; i <= 21; i++) {
      storage.recordFolderBookmark({ id: uuid(i), absPath: `/path/${i}` });
    }

    const list = storage.listFolderBookmarks();
    const fav = list.find((b) => b.absPath === "/path/fav");
    expect(fav).toBeDefined();
    expect(fav?.favorite).toBe(true);

    const nonFavCount = list.filter((b) => !b.favorite).length;
    expect(nonFavCount).toBe(20);
  });
});

describe("GlobalStorage.removeWorkspace — entry-point table isolation", () => {
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

  it("removing a workspace leaves folder_bookmarks intact", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/home/project" });
    storage.removeWorkspace("00000000-0000-0000-0000-000000000001");

    expect(storage.listWorkspaces().length).toBe(0);
    expect(storage.listFolderBookmarks().length).toBe(1);
  });

  it("removing a workspace leaves connection_profiles intact", () => {
    storage.recordConnectionProfile({
      id: uuid(1),
      host: "devbox",
      user: "alice",
      port: 22,
    });
    storage.removeWorkspace("00000000-0000-0000-0000-000000000001");

    expect(storage.listWorkspaces().length).toBe(0);
    expect(storage.listConnectionProfiles().length).toBe(1);
  });
});

describe("GlobalStorage.recordConnectionProfile — SSH normalization", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("null port and explicit port=22 resolve to same natural key — no duplicate", () => {
    storage.recordConnectionProfile({ id: uuid(1), host: "devbox", user: "alice", port: null });
    storage.recordConnectionProfile({ id: uuid(2), host: "devbox", user: "alice", port: 22 });
    expect(storage.listConnectionProfiles().length).toBe(1);
  });

  it("different ports produce different rows", () => {
    storage.recordConnectionProfile({ id: uuid(1), host: "devbox", user: "alice", port: 22 });
    storage.recordConnectionProfile({ id: uuid(2), host: "devbox", user: "alice", port: 2222 });
    expect(storage.listConnectionProfiles().length).toBe(2);
  });

  it("upsert with same (host,user,port) updates last_used_at only, no new row", () => {
    storage.recordConnectionProfile({ id: uuid(1), host: "devbox", user: "alice", port: 22 });
    const before = storage.listConnectionProfiles()[0].lastUsedAt;

    db.prepare(
      "UPDATE connection_profiles SET last_used_at = ? WHERE host = ? AND user = ? AND port = ?",
    ).run(before - 1000, "devbox", "alice", 22);

    storage.recordConnectionProfile({ id: uuid(2), host: "devbox", user: "alice", port: 22 });
    const after = storage.listConnectionProfiles()[0].lastUsedAt;

    expect(storage.listConnectionProfiles().length).toBe(1);
    expect(after).toBeGreaterThan(before - 1000);
  });

  it("connection_profiles cap eviction: 21st non-favorite evicts oldest", () => {
    for (let i = 1; i <= 20; i++) {
      db.prepare(
        `INSERT INTO connection_profiles
           (id, label, host, user, port, identity_file, auth_mode, favorite, last_used_at, created_at)
         VALUES (?, NULL, ?, ?, ?, NULL, 'interactive', 0, ?, ?)`,
      ).run(uuid(i), `host${i}.example.com`, "alice", 22, i * 1000, i * 1000);
    }
    expect(storage.listConnectionProfiles().length).toBe(20);

    storage.recordConnectionProfile({
      id: uuid(21),
      host: "host21.example.com",
      user: "alice",
      port: 22,
    });
    expect(storage.listConnectionProfiles().length).toBe(20);
    const hosts = storage.listConnectionProfiles().map((p) => p.host);
    expect(hosts).toContain("host21.example.com");
    expect(hosts).not.toContain("host1.example.com");
  });

  it("favorite connection profiles are not evicted by cap", () => {
    storage.recordConnectionProfile({ id: uuid(1), host: "favhost", user: "alice", port: 22 });
    storage.setConnectionProfileFavorite(uuid(1), true);

    for (let i = 2; i <= 22; i++) {
      storage.recordConnectionProfile({
        id: uuid(i),
        host: `host${i}.example.com`,
        user: "alice",
        port: 22,
      });
    }

    const list = storage.listConnectionProfiles();
    const fav = list.find((p) => p.host === "favhost");
    expect(fav).toBeDefined();
    expect(fav?.favorite).toBe(true);
    const nonFavCount = list.filter((p) => !p.favorite).length;
    expect(nonFavCount).toBe(20);
  });
});
