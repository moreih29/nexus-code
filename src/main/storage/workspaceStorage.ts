import fs from "node:fs";
import path from "node:path";
import type { WorkspaceMeta } from "../../shared/types/workspace";
import type { SqliteDb } from "./migrations";

// ---------------------------------------------------------------------------
// WorkspaceStorage — per-workspace SQLite DB + workspace.json recovery dump.
//
// Directory layout (under userData/workspaces/<uuid>/):
//   state.db      — SQLite KV store for tabs/session/ring-buffer (M0: meta only)
//   workspace.json — WorkspaceMeta JSON dump for recovery when state.db is corrupt
//
// NEXUS_RESET_STORAGE=1 environment variable:
//   On first open, if this var is set, the workspace storage folder is renamed
//   to backup-{timestamp} and a fresh directory is created.
//   This fast path is intentionally limited to M0/M1 and will be removed in M2.
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
   * This env-var behaviour is limited to M0/M1 — remove in M2.
   */
  openForWorkspace(workspaceId: string): void {
    if (this.entries.has(workspaceId)) {
      return;
    }

    const workspaceDir = path.join(this.baseDir, workspaceId);

    // NEXUS_RESET_STORAGE=1 fast path (M0/M1 only — remove in M2).
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schemaVersion', '1')").run();
    }

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
}
