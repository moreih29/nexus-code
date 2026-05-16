/**
 * Per-workspace SQLite schema migrations.
 *
 * Each entry is run once when the stored `schemaVersion` is below its
 * `version`. Migrations are append-only: once an entry has shipped to a
 * user, do NOT edit it — add a new entry below. Editing in place would
 * mean databases that already ran the entry skip the patched DDL and end
 * up out of sync with fresh databases.
 *
 * Helpers (`hasColumn`, `addColumnIfMissing`, `sqliteStringLiteral`) are
 * also exported so the migration entries can stay declarative and the
 * storage module can reuse them where helpful.
 */

import { DEFAULT_GIT_PANEL_STATE } from "../../../shared/git/types";
import type { SqliteDb } from "./migrations";

export interface WorkspaceMigration {
  version: number;
  up: (db: SqliteDb) => void;
}

/**
 * Escapes a string so it can be embedded directly into a DDL literal.
 * Migrations cannot bind parameters in DEFAULT clauses, so the literal must
 * be embedded safely (doubled single quotes per SQLite rules).
 */
export function sqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Returns whether the named column is present on a workspace-local table.
 * Used by idempotent ALTER TABLE migrations that may run after partial setup.
 */
export function hasColumn(db: SqliteDb, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  return rows.some((row) => row.name === columnName);
}

/**
 * Adds a column only when absent so rerunning a migration against a partially
 * upgraded workspace database does not fail with "duplicate column name".
 */
export function addColumnIfMissing(
  db: SqliteDb,
  tableName: string,
  columnName: string,
  columnSql: string,
): void {
  if (hasColumn(db, tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql};`);
}

export const WORKSPACE_DB_MIGRATIONS: WorkspaceMigration[] = [
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
  // v3 → git_panel_state table for persisting Source Control panel UI state.
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS git_panel_state (
          key   TEXT NOT NULL PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  // v4 → panel_view_options table for persisting viewMode/compactFolders per panel kind.
  //      panel_kind is the PRIMARY KEY so adding new panels requires only a new row,
  //      not a schema change.
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS panel_view_options (
          panel_kind       TEXT    NOT NULL PRIMARY KEY,
          view_mode        TEXT    NOT NULL,
          compact_folders  INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  // v5 → persisted git panel preferences added after the original key/value
  //      Source Control panel table. The table keeps its legacy rows so
  //      existing commit drafts and expanded groups are not rewritten.
  {
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS git_panel_state (
          key   TEXT NOT NULL PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      addColumnIfMissing(
        db,
        "git_panel_state",
        "commit_options",
        `commit_options TEXT NOT NULL DEFAULT ${sqliteStringLiteral(
          JSON.stringify(DEFAULT_GIT_PANEL_STATE.commitOptions),
        )}`,
      );
      addColumnIfMissing(
        db,
        "git_panel_state",
        "autofetch_interval_min",
        "autofetch_interval_min INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "git_panel_state",
        "autofetch_manual_paused",
        "autofetch_manual_paused INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "git_panel_state",
        "protected_branches",
        `protected_branches TEXT NOT NULL DEFAULT ${sqliteStringLiteral(
          JSON.stringify(DEFAULT_GIT_PANEL_STATE.protectedBranches),
        )}`,
      );
    },
  },
];

/**
 * Walks the migration list and runs every entry whose `version` exceeds the
 * stored `schemaVersion`. Each successful run advances `schemaVersion`
 * atomically with the migration's DDL via SQLite's `INSERT OR REPLACE`.
 */
export function applyWorkspaceMigrations(db: SqliteDb): void {
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
