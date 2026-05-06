import fs from "node:fs";
import path from "node:path";
import type { WorkspaceMeta } from "../../shared/types/workspace";
import type { SqliteDb } from "./migrations";

// ---------------------------------------------------------------------------
// Per-workspace DB migrations
//
// Each entry runs when the stored schemaVersion is below the entry's version.
// Once shipped, do NOT edit — add a new entry instead.
// ---------------------------------------------------------------------------

interface WorkspaceMigration {
  version: number;
  up: (db: SqliteDb) => void;
}

const WORKSPACE_DB_MIGRATIONS: WorkspaceMigration[] = [
  // v1 → initial schema (bootstrapped inline in openForWorkspace before this list ran).
  // Listed here so the migration loop has a stable baseline.
  { version: 1, up: () => {} },
  // v2 → expanded_paths table for persisting file-tree expand state.
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS expanded_paths (
          rel_path TEXT NOT NULL PRIMARY KEY
        );
      `);
    },
  },
];

function applyWorkspaceMigrations(db: SqliteDb): void {
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
    | { value: string }
    | undefined;
  let current = row ? parseInt(row.value, 10) : 1;

  for (const migration of WORKSPACE_DB_MIGRATIONS) {
    if (migration.version <= current) continue;
    migration.up(db);
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schemaVersion', ?)").run(
      String(migration.version),
    );
    current = migration.version;
  }
}

// ---------------------------------------------------------------------------
// WorkspaceStorage — per-workspace SQLite DB + workspace.json recovery dump.
//
// Directory layout (under userData/workspaces/<uuid>/):
//   state.db      — SQLite store for workspace metadata and persisted UI state
//   workspace.json — WorkspaceMeta JSON dump for recovery when state.db is corrupt
//
// NEXUS_RESET_STORAGE=1 environment variable:
//   On first open, if this var is set, the workspace storage folder is renamed
//   to backup-{timestamp} and a fresh directory is created.
//   This fast path is temporary and will be removed once reset UX is formalized.
// ---------------------------------------------------------------------------

interface PerWorkspaceEntry {
  db: SqliteDb;
  dbPath: string;
  workspaceDir: string;
}

type DbFactory = (dbPath: string) => SqliteDb;

export class WorkspaceStorage {
  private readonly entries = new Map<string, PerWorkspaceEntry>();
  private readonly baseDir: string;
  private readonly dbFactory: DbFactory;

  constructor(baseDir: string, dbFactory?: DbFactory) {
    this.baseDir = baseDir;
    if (dbFactory) {
      this.dbFactory = dbFactory;
    } else {
      // Default factory uses better-sqlite3 for production.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BetterSQLite = require("better-sqlite3");
      this.dbFactory = (p: string) => new BetterSQLite(p) as SqliteDb;
    }
  }

  /**
   * Open (or lazily create) per-workspace storage.
   * Applies NEXUS_RESET_STORAGE=1 fast path when the env var is set.
   * This env-var behaviour is temporary — remove once reset UX is formalized.
   */
  openForWorkspace(workspaceId: string): void {
    if (this.entries.has(workspaceId)) {
      return;
    }

    const workspaceDir = path.join(this.baseDir, workspaceId);

    // NEXUS_RESET_STORAGE=1 fast path; temporary until reset UX is formalized.
    if (process.env.NEXUS_RESET_STORAGE === "1" && fs.existsSync(workspaceDir)) {
      const backupName = `backup-${Date.now()}`;
      const backupDir = path.join(this.baseDir, backupName);
      fs.renameSync(workspaceDir, backupDir);
    }

    fs.mkdirSync(workspaceDir, { recursive: true });

    const dbPath = path.join(workspaceDir, "state.db");
    const db = this.dbFactory(dbPath);

    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    // Bootstrap _meta before running migrations.
    db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Seed schemaVersion=1 for fresh databases so applyWorkspaceMigrations
    // knows where to start.
    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schemaVersion', '1')").run();
    }

    applyWorkspaceMigrations(db);

    this.entries.set(workspaceId, { db, dbPath, workspaceDir });
  }

  closeForWorkspace(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      return;
    }
    entry.db.close();
    this.entries.delete(workspaceId);
  }

  getMeta(workspaceId: string): WorkspaceMeta | undefined {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      return undefined;
    }
    const row = entry.db.prepare("SELECT value FROM _meta WHERE key = 'workspaceMeta'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      return undefined;
    }
    return JSON.parse(row.value) as WorkspaceMeta;
  }

  setMeta(workspaceId: string, meta: WorkspaceMeta): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    const serialized = JSON.stringify(meta);
    entry.db
      .prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('workspaceMeta', ?)")
      .run(serialized);

    // Write recovery dump.
    const jsonPath = path.join(entry.workspaceDir, "workspace.json");
    fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2), "utf8");
  }

  /**
   * Returns the workspace directory path for a given workspace ID.
   * The directory is only present after openForWorkspace() has been called.
   */
  getWorkspaceDir(workspaceId: string): string {
    return path.join(this.baseDir, workspaceId);
  }

  isOpen(workspaceId: string): boolean {
    return this.entries.has(workspaceId);
  }

  /**
   * Returns the persisted relative paths of expanded directories for a workspace.
   * Returns [] if none have been saved yet.
   */
  getExpandedPaths(workspaceId: string): string[] {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    const rows = entry.db.prepare("SELECT rel_path FROM expanded_paths").all() as {
      rel_path: string;
    }[];
    return rows.map((r) => r.rel_path);
  }

  /**
   * Replaces the full set of persisted expanded paths for a workspace.
   * Uses a transaction: DELETE all existing rows then INSERT the new set.
   */
  setExpandedPaths(workspaceId: string, relPaths: string[]): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }
    const del = entry.db.prepare("DELETE FROM expanded_paths");
    const ins = entry.db.prepare("INSERT INTO expanded_paths (rel_path) VALUES (?)");
    // bun:sqlite and better-sqlite3 both expose transaction() on the db object.
    // We call it via exec-level statements wrapped in BEGIN/COMMIT to stay
    // compatible with the shared SqliteDb interface (which has only exec/prepare/close).
    entry.db.exec("BEGIN");
    try {
      del.run();
      for (const rp of relPaths) {
        ins.run(rp);
      }
      entry.db.exec("COMMIT");
    } catch (err) {
      entry.db.exec("ROLLBACK");
      throw err;
    }
  }
}
