import { DEFAULT_GIT_PANEL_STATE } from "../../../shared/git/types";
import type { SqliteDb } from "./migrations";

export interface WorkspaceMigration {
  version: number;
  up: (db: SqliteDb) => void;
}

export function sqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function hasColumn(db: SqliteDb, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  return rows.some((row) => row.name === columnName);
}

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
  { version: 1, up: () => {} },
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
  {
    version: 6,
    up: (db) => {
      if (hasColumn(db, "panel_view_options", "compact_folders")) {
        db.exec("ALTER TABLE panel_view_options DROP COLUMN compact_folders;");
      }
    },
  },
  {
    version: 7,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS origin_permissions (
          origin      TEXT    NOT NULL,
          permission  TEXT    NOT NULL,
          decision    TEXT    NOT NULL CHECK(decision IN ('allow','block')),
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (origin, permission)
        );
        CREATE INDEX IF NOT EXISTS idx_origin_permissions_origin
          ON origin_permissions(origin);
      `);
    },
  },
];

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
