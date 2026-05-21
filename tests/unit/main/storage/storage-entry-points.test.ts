/**
 * Tester-authored integration tests for T1 + T2:
 *   - migration v4 (folder_bookmarks + connection_profiles tables)
 *   - GlobalStorage entry-point methods (upsert, cap eviction, favorites, remove)
 *   - removeWorkspace isolation (no cascade into entry-point tables)
 *   - SSH null user/port normalization (no duplicate rows)
 *   - IPC handler zod validation (validateArgs) — inline simulation
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalStorage } from "../../../../src/main/infra/storage/global-storage";
import { applyMigrations } from "../../../../src/main/infra/storage/migrations";
import {
  ConnectionProfileSaveArgsSchema,
  FolderBookmarkFavoriteArgsSchema,
  FolderBookmarkIdArgsSchema,
  FolderBookmarkRecordArgsSchema,
  FolderBookmarkSchema,
  LocalFolderBookmarkSchema,
  SshFolderBookmarkSchema,
  ConnectionProfileSchema,
  ConnectionProfileFavoriteArgsSchema,
  ConnectionProfileIdArgsSchema,
} from "../../../../src/shared/types/entry-points";
import type { WorkspaceMeta } from "../../../../src/shared/types/workspace";
import os from "node:os";
import path from "node:path";

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

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// AC-1: v4 migration — fresh DB and v3 DB
// ---------------------------------------------------------------------------

describe("migration v4 — fresh DB", () => {
  it("creates folder_bookmarks and connection_profiles tables", () => {
    const db = makeDb();
    applyMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("folder_bookmarks");
    expect(names).toContain("connection_profiles");
    db.close();
  });

  it("creates partial UNIQUE indexes on folder_bookmarks (local_path, ssh_path, recency)", () => {
    const db = makeDb();
    applyMigrations(db);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='folder_bookmarks'",
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    // v5 replaced the single abs_path index with two partial indexes
    expect(names).toContain("idx_folder_bookmarks_local_path");
    expect(names).toContain("idx_folder_bookmarks_ssh_path");
    expect(names).toContain("idx_folder_bookmarks_recency");
    expect(names).not.toContain("idx_folder_bookmarks_abs_path");
    db.close();
  });

  it("creates UNIQUE index on connection_profiles(host, user, port)", () => {
    const db = makeDb();
    applyMigrations(db);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='connection_profiles'",
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_connection_profiles_natural_key");
    expect(names).toContain("idx_connection_profiles_recency");
    db.close();
  });

  it("schemaVersion is 6 after fresh migration", () => {
    const db = makeDb();
    applyMigrations(db);
    const row = db.prepare("SELECT value FROM _meta WHERE key='schemaVersion'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("6");
    db.close();
  });
});

describe("migration v4 — applied on top of existing v3 DB", () => {
  it("applies v4 without error on a v3 database that already has workspaces", () => {
    const db = makeDb();

    // Simulate a v3-level database (has _meta, workspaces, location column)
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
    `).run("00000000-0000-0000-0000-000000000001", "legacy", "/legacy", null, "default", 0, 1700000000000);

    // Apply v4 migration — must not throw
    expect(() => applyMigrations(db)).not.toThrow();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("folder_bookmarks");
    expect(names).toContain("connection_profiles");

    // Existing workspace row unaffected
    const ws = db.prepare("SELECT id FROM workspaces").get() as { id: string };
    expect(ws.id).toBe("00000000-0000-0000-0000-000000000001");

    db.close();
  });

  it("migration is idempotent — second applyMigrations does not throw", () => {
    const db = makeDb();
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();

    const row = db.prepare("SELECT value FROM _meta WHERE key='schemaVersion'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("6");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// AC-2: folder_bookmark upsert — same abs_path updates last_used_at only
// ---------------------------------------------------------------------------

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

  it("first call inserts a row", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/home/user/project" });
    const list = storage.listFolderBookmarks();
    expect(list.length).toBe(1);
    expect(list[0].absPath).toBe("/home/user/project");
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

    // Force a slightly later timestamp
    const oldAt = db
      .prepare("SELECT last_used_at FROM folder_bookmarks WHERE abs_path = ?")
      .get("/home/user/project") as { last_used_at: number };

    // Manually set last_used_at to an older value to verify it changes
    db.prepare("UPDATE folder_bookmarks SET last_used_at = ? WHERE abs_path = ?").run(
      oldAt.last_used_at - 1000,
      "/home/user/project",
    );

    storage.recordFolderBookmark({ id: uuid(2), absPath: "/home/user/project" });
    const after = storage.listFolderBookmarks()[0].lastUsedAt;
    expect(after).toBeGreaterThan(before - 1000);
    // Row count is still 1
    expect(storage.listFolderBookmarks().length).toBe(1);
  });

  it("label field carries through on insert", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/a", label: "My Project" });
    expect(storage.listFolderBookmarks()[0].label).toBe("My Project");
  });
});

// ---------------------------------------------------------------------------
// AC-3: folder_bookmark cap eviction — boundary 20/21
// ---------------------------------------------------------------------------

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

  it("exactly 20 non-favorite rows — none evicted", () => {
    for (let i = 1; i <= 20; i++) {
      storage.recordFolderBookmark({ id: uuid(i), absPath: `/path/${i}` });
    }
    expect(storage.listFolderBookmarks().length).toBe(20);
  });

  it("21st non-favorite row evicts the oldest", () => {
    // Pre-seed 20 rows with strictly increasing timestamps so eviction order is deterministic
    for (let i = 1; i <= 20; i++) {
      db.prepare(
        `INSERT INTO folder_bookmarks (id, abs_path, label, favorite, last_used_at, created_at)
         VALUES (?, ?, NULL, 0, ?, ?)`,
      ).run(uuid(i), `/path/${i}`, i * 1000, i * 1000);
    }
    // path/1 has last_used_at=1000 — the oldest non-favorite row
    // Calling record for path/21 inserts it and evicts the oldest
    storage.recordFolderBookmark({ id: uuid(21), absPath: "/path/21" });

    const list = storage.listFolderBookmarks();
    expect(list.length).toBe(20);
    const paths = list.map((b) => b.absPath);
    expect(paths).not.toContain("/path/1");
    expect(paths).toContain("/path/21");
  });

  it("favorite rows are NOT evicted regardless of cap", () => {
    // Insert 1 favorite first
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/path/fav" });
    storage.setFolderBookmarkFavorite(uuid(1), true);

    // Fill 20 non-favorite rows
    for (let i = 2; i <= 21; i++) {
      storage.recordFolderBookmark({ id: uuid(i), absPath: `/path/${i}` });
    }

    // Total = 21 non-favorites + 1 favorite = 22 but favorite is preserved
    const list = storage.listFolderBookmarks();
    const fav = list.find((b) => b.absPath === "/path/fav");
    expect(fav).toBeDefined();
    expect(fav?.favorite).toBe(true);

    // Non-favorite count is capped at 20
    const nonFavCount = list.filter((b) => !b.favorite).length;
    expect(nonFavCount).toBe(20);
  });

  it("22nd non-favorite evicts correctly — still 20 non-favorites", () => {
    for (let i = 1; i <= 22; i++) {
      storage.recordFolderBookmark({ id: uuid(i), absPath: `/path/${i}` });
    }
    const list = storage.listFolderBookmarks();
    const nonFavCount = list.filter((b) => !b.favorite).length;
    expect(nonFavCount).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// AC-4: removeWorkspace does NOT affect entry-point tables
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AC-5: SSH null user/port normalization — no duplicates
// ---------------------------------------------------------------------------

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

  it("port defaults to 22 when not provided", () => {
    storage.recordConnectionProfile({ id: uuid(1), host: "devbox", user: "alice" });
    const list = storage.listConnectionProfiles();
    expect(list.length).toBe(1);
    expect(list[0].port).toBe(22);
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

    // Force older timestamp
    db.prepare(
      "UPDATE connection_profiles SET last_used_at = ? WHERE host = ? AND user = ? AND port = ?",
    ).run(before - 1000, "devbox", "alice", 22);

    storage.recordConnectionProfile({ id: uuid(2), host: "devbox", user: "alice", port: 22 });
    const after = storage.listConnectionProfiles()[0].lastUsedAt;

    expect(storage.listConnectionProfiles().length).toBe(1);
    expect(after).toBeGreaterThan(before - 1000);
  });

  it("connection_profiles cap eviction: 21st non-favorite evicts oldest", () => {
    // Pre-seed 20 rows with strictly increasing timestamps for deterministic eviction
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

// ---------------------------------------------------------------------------
// AC-5b: setFavorite / remove round-trips
// ---------------------------------------------------------------------------

describe("GlobalStorage folder_bookmark — setFavorite / remove", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("setFolderBookmarkFavorite toggles favorite flag", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/path/a" });
    storage.setFolderBookmarkFavorite(uuid(1), true);
    expect(storage.listFolderBookmarks()[0].favorite).toBe(true);

    storage.setFolderBookmarkFavorite(uuid(1), false);
    expect(storage.listFolderBookmarks()[0].favorite).toBe(false);
  });

  it("removeFolderBookmark deletes the row", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/path/a" });
    storage.removeFolderBookmark(uuid(1));
    expect(storage.listFolderBookmarks().length).toBe(0);
  });

  it("removeFolderBookmark is a no-op for non-existent id", () => {
    storage.recordFolderBookmark({ id: uuid(1), absPath: "/path/a" });
    storage.removeFolderBookmark(uuid(99));
    expect(storage.listFolderBookmarks().length).toBe(1);
  });
});

describe("GlobalStorage connectionProfile — setFavorite / remove", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  it("setConnectionProfileFavorite toggles favorite flag", () => {
    storage.recordConnectionProfile({ id: uuid(1), host: "devbox", user: "alice", port: 22 });
    storage.setConnectionProfileFavorite(uuid(1), true);
    expect(storage.listConnectionProfiles()[0].favorite).toBe(true);

    storage.setConnectionProfileFavorite(uuid(1), false);
    expect(storage.listConnectionProfiles()[0].favorite).toBe(false);
  });

  it("removeConnectionProfile deletes the row", () => {
    storage.recordConnectionProfile({ id: uuid(1), host: "devbox", user: "alice", port: 22 });
    storage.removeConnectionProfile(uuid(1));
    expect(storage.listConnectionProfiles().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-6: IPC schema validation — zod schemas, no secret fields
// ---------------------------------------------------------------------------

describe("IPC zod schema — FolderBookmark", () => {
  it("FolderBookmarkSchema accepts valid local bookmark", () => {
    const result = FolderBookmarkSchema.safeParse({
      id: uuid(1),
      kind: "local",
      absPath: "/home/user/project",
      label: null,
      favorite: false,
      lastUsedAt: 1700000000000,
      createdAt: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  it("FolderBookmarkSchema accepts valid ssh bookmark", () => {
    const result = FolderBookmarkSchema.safeParse({
      id: uuid(1),
      kind: "ssh",
      absPath: "/remote/project",
      connectionProfileId: uuid(2),
      label: null,
      favorite: false,
      lastUsedAt: 1700000000000,
      createdAt: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  it("FolderBookmarkSchema rejects empty absPath", () => {
    const result = FolderBookmarkSchema.safeParse({
      id: uuid(1),
      kind: "local",
      absPath: "",
      label: null,
      favorite: false,
      lastUsedAt: 1700000000000,
      createdAt: 1700000000000,
    });
    expect(result.success).toBe(false);
  });

  it("FolderBookmarkSchema has no password/secret/privateKey field", () => {
    // FolderBookmarkSchema is a discriminatedUnion — check options instead of shape
    const localKeys = Object.keys(LocalFolderBookmarkSchema.shape);
    const sshKeys = Object.keys(SshFolderBookmarkSchema.shape);
    for (const key of [...localKeys, ...sshKeys]) {
      expect(key.toLowerCase()).not.toMatch(/password|secret|private.?key|token|credential/);
    }
  });

  it("FolderBookmarkRecordArgsSchema requires uuid id and non-empty absPath", () => {
    expect(
      FolderBookmarkRecordArgsSchema.safeParse({ id: uuid(1), absPath: "/a" }).success,
    ).toBe(true);
    expect(
      FolderBookmarkRecordArgsSchema.safeParse({ id: "not-a-uuid", absPath: "/a" }).success,
    ).toBe(false);
    expect(
      FolderBookmarkRecordArgsSchema.safeParse({ id: uuid(1), absPath: "" }).success,
    ).toBe(false);
  });

  it("FolderBookmarkFavoriteArgsSchema requires favorite boolean", () => {
    expect(
      FolderBookmarkFavoriteArgsSchema.safeParse({ id: uuid(1), favorite: true }).success,
    ).toBe(true);
    expect(
      FolderBookmarkFavoriteArgsSchema.safeParse({ id: uuid(1), favorite: "yes" }).success,
    ).toBe(false);
  });

  it("FolderBookmarkIdArgsSchema requires uuid", () => {
    expect(FolderBookmarkIdArgsSchema.safeParse({ id: uuid(1) }).success).toBe(true);
    expect(FolderBookmarkIdArgsSchema.safeParse({ id: "bad" }).success).toBe(false);
  });
});

describe("IPC zod schema — ConnectionProfile", () => {
  it("ConnectionProfileSchema accepts valid data", () => {
    const result = ConnectionProfileSchema.safeParse({
      id: uuid(1),
      label: null,
      host: "devbox",
      user: "alice",
      port: 22,
      identityFile: null,
      authMode: "interactive",
      favorite: false,
      lastUsedAt: 1700000000000,
      createdAt: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  it("ConnectionProfileSchema rejects port out of range (0)", () => {
    const result = ConnectionProfileSchema.safeParse({
      id: uuid(1),
      label: null,
      host: "devbox",
      user: "alice",
      port: 0,
      identityFile: null,
      authMode: "interactive",
      favorite: false,
      lastUsedAt: 1700000000000,
      createdAt: 1700000000000,
    });
    expect(result.success).toBe(false);
  });

  it("ConnectionProfileSchema rejects port > 65535", () => {
    const result = ConnectionProfileSchema.safeParse({
      id: uuid(1),
      label: null,
      host: "devbox",
      user: "alice",
      port: 65536,
      identityFile: null,
      authMode: "interactive",
      favorite: false,
      lastUsedAt: 1700000000000,
      createdAt: 1700000000000,
    });
    expect(result.success).toBe(false);
  });

  it("ConnectionProfileSchema has no password/secret field", () => {
    const shape = ConnectionProfileSchema.shape;
    const keys = Object.keys(shape);
    for (const key of keys) {
      expect(key.toLowerCase()).not.toMatch(/password|secret|private.?key|token|credential/);
    }
  });

  it("ConnectionProfileSaveArgsSchema accepts valid connection args", () => {
    const result = ConnectionProfileSaveArgsSchema.safeParse({
      id: uuid(1),
      host: "devbox",
      user: "alice",
      port: 22,
    });
    expect(result.success).toBe(true);
  });

  it("ConnectionProfileSaveArgsSchema rejects empty host", () => {
    const result = ConnectionProfileSaveArgsSchema.safeParse({
      id: uuid(1),
      host: "",
      user: "alice",
    });
    expect(result.success).toBe(false);
  });

  it("ConnectionProfileSaveArgsSchema defaults authMode to interactive", () => {
    const result = ConnectionProfileSaveArgsSchema.safeParse({
      id: uuid(1),
      host: "devbox",
      user: "alice",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authMode).toBe("interactive");
    }
  });

  it("ConnectionProfileFavoriteArgsSchema requires favorite boolean", () => {
    expect(
      ConnectionProfileFavoriteArgsSchema.safeParse({ id: uuid(1), favorite: false }).success,
    ).toBe(true);
    expect(
      ConnectionProfileFavoriteArgsSchema.safeParse({ id: uuid(1), favorite: 0 }).success,
    ).toBe(false);
  });

  it("ConnectionProfileIdArgsSchema requires uuid", () => {
    expect(ConnectionProfileIdArgsSchema.safeParse({ id: uuid(1) }).success).toBe(true);
    expect(ConnectionProfileIdArgsSchema.safeParse({ id: "" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-6b: IPC handler integration — inline handler simulation
// (No Electron dependency — tests the handler logic with real DB and zod)
// ---------------------------------------------------------------------------

describe("IPC handler simulation — folderBookmark channel", () => {
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
   * Simulates the handler logic from ipc.ts without Electron, using
   * the same validateArgs pattern.
   */
  function simulateRecord(args: unknown): void {
    const params = FolderBookmarkRecordArgsSchema.parse(args);
    storage.recordFolderBookmark(params);
  }

  function simulateList(_args: unknown): ReturnType<GlobalStorage["listFolderBookmarks"]> {
    return storage.listFolderBookmarks();
  }

  function simulateSetFavorite(args: unknown): void {
    const { id, favorite } = FolderBookmarkFavoriteArgsSchema.parse(args);
    storage.setFolderBookmarkFavorite(id, favorite);
  }

  function simulateRemove(args: unknown): void {
    const { id } = FolderBookmarkIdArgsSchema.parse(args);
    storage.removeFolderBookmark(id);
  }

  it("round-trip: record → list → setFavorite → remove", () => {
    simulateRecord({ id: uuid(1), absPath: "/home/user/proj" });
    const list = simulateList(undefined);
    expect(list.length).toBe(1);
    expect(list[0].absPath).toBe("/home/user/proj");
    expect(list[0].favorite).toBe(false);

    simulateSetFavorite({ id: uuid(1), favorite: true });
    expect(simulateList(undefined)[0].favorite).toBe(true);

    simulateRemove({ id: uuid(1) });
    expect(simulateList(undefined).length).toBe(0);
  });

  it("zod validation rejects invalid record args", () => {
    expect(() => simulateRecord({ id: "not-uuid", absPath: "/home/user/proj" })).toThrow();
    expect(() => simulateRecord({ id: uuid(1), absPath: "" })).toThrow();
    expect(() => simulateRecord({ id: uuid(1) })).toThrow();
  });

  it("zod validation rejects invalid setFavorite args", () => {
    expect(() => simulateSetFavorite({ id: uuid(1), favorite: 1 })).toThrow();
    expect(() => simulateSetFavorite({ id: "bad" })).toThrow();
  });

  it("zod validation rejects invalid remove args", () => {
    expect(() => simulateRemove({ id: "not-uuid" })).toThrow();
    expect(() => simulateRemove({})).toThrow();
  });
});

describe("IPC handler simulation — connectionProfile channel", () => {
  let db: Database;
  let storage: GlobalStorage;

  beforeEach(() => {
    db = makeDb();
    storage = new GlobalStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  function simulateSave(args: unknown): void {
    const params = ConnectionProfileSaveArgsSchema.parse(args);
    storage.recordConnectionProfile({
      id: params.id,
      label: params.label,
      host: params.host,
      user: params.user,
      port: params.port,
      identityFile: params.identityFile,
      authMode: params.authMode,
    });
  }

  function simulateList(): ReturnType<GlobalStorage["listConnectionProfiles"]> {
    return storage.listConnectionProfiles();
  }

  function simulateSetFavorite(args: unknown): void {
    const { id, favorite } = ConnectionProfileFavoriteArgsSchema.parse(args);
    storage.setConnectionProfileFavorite(id, favorite);
  }

  function simulateRemove(args: unknown): void {
    const { id } = ConnectionProfileIdArgsSchema.parse(args);
    storage.removeConnectionProfile(id);
  }

  it("round-trip: save → list → setFavorite → remove", () => {
    simulateSave({ id: uuid(1), host: "devbox", user: "alice", port: 22 });
    const list = simulateList();
    expect(list.length).toBe(1);
    expect(list[0].host).toBe("devbox");
    expect(list[0].user).toBe("alice");
    expect(list[0].port).toBe(22);
    expect(list[0].favorite).toBe(false);

    simulateSetFavorite({ id: uuid(1), favorite: true });
    expect(simulateList()[0].favorite).toBe(true);

    simulateRemove({ id: uuid(1) });
    expect(simulateList().length).toBe(0);
  });

  it("zod validation rejects invalid save args", () => {
    expect(() => simulateSave({ id: uuid(1), host: "", user: "alice" })).toThrow();
    expect(() => simulateSave({ id: "bad", host: "devbox", user: "alice" })).toThrow();
    expect(() => simulateSave({ id: uuid(1), host: "devbox", user: "alice", port: 99999 })).toThrow();
  });

  it("zod validation rejects invalid setFavorite args", () => {
    expect(() => simulateSetFavorite({ id: uuid(1), favorite: "yes" })).toThrow();
  });

  it("zod validation rejects invalid remove args", () => {
    expect(() => simulateRemove({ id: "bad" })).toThrow();
  });

  it("save with no port — port normalized to 22, no duplicate on second save", () => {
    simulateSave({ id: uuid(1), host: "devbox", user: "alice" });
    simulateSave({ id: uuid(2), host: "devbox", user: "alice" }); // same natural key
    expect(simulateList().length).toBe(1);
    expect(simulateList()[0].port).toBe(22);
  });
});
