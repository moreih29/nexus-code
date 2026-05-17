// ---------------------------------------------------------------------------
// SQLite schema migrations
//
// Each migration is identified by a version number and is idempotent.
// The _meta table records schemaVersion so migrations only run once.
// ---------------------------------------------------------------------------

// Minimal synchronous SQLite interface shared by better-sqlite3 (production)
// and bun:sqlite (unit tests).
export interface SqliteStatement {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export interface Migration {
  version: number;
  up: (db: SqliteDb) => void;
}

/**
 * Returns true when the named table already has the requested column.
 */
function hasColumn(db: SqliteDb, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  return columns.some((column) => column.name === columnName);
}

/**
 * Adds and backfills the workspace location JSON column from legacy root_path.
 */
function migrateWorkspaceLocations(db: SqliteDb): void {
  if (!hasColumn(db, "workspaces", "location")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN location TEXT;");
  }

  const rows = db
    .prepare("SELECT id, root_path FROM workspaces WHERE location IS NULL OR location = ''")
    .all() as { id: string; root_path: string }[];
  const update = db.prepare("UPDATE workspaces SET location = ? WHERE id = ?");

  for (const row of rows) {
    update.run(JSON.stringify({ kind: "local", rootPath: row.root_path }), row.id);
  }
}

// Migration history.
//
// Once a version has shipped, do NOT edit it — add a follow-up version instead.
// Each `up` runs in its own transaction implicitly via applyMigrations.
export const MIGRATIONS: Migration[] = [
  // Initial workspace metadata schema.
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS _meta (
          key   TEXT NOT NULL PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspaces (
          id             TEXT NOT NULL PRIMARY KEY,
          name           TEXT NOT NULL,
          root_path      TEXT NOT NULL,
          color_tone     TEXT NOT NULL DEFAULT 'default',
          pinned         INTEGER NOT NULL DEFAULT 0,
          category       TEXT NOT NULL DEFAULT 'DEFAULT',
          last_opened_at INTEGER NOT NULL
        );
      `);
    },
  },
  // Drop unused `category` column. Requires SQLite >= 3.35 for
  // ALTER TABLE ... DROP COLUMN — both better-sqlite3 (>= 9.x) and
  // bun:sqlite ship newer SQLite, so this is safe in both runtimes.
  {
    version: 2,
    up: (db) => {
      db.exec(`ALTER TABLE workspaces DROP COLUMN category;`);
    },
  },
  // Add discriminated workspace locations while preserving legacy root_path.
  {
    version: 3,
    up: migrateWorkspaceLocations,
  },
  // Add entry-point persistence tables — folder_bookmarks and connection_profiles.
  // These tables are intentionally decoupled from the workspaces table (no FK)
  // so that hard-deleting a workspace never cascades into entry-point history.
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS folder_bookmarks (
          id          TEXT    NOT NULL PRIMARY KEY,
          abs_path    TEXT    NOT NULL,
          label       TEXT,
          favorite    INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER NOT NULL,
          created_at   INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_bookmarks_abs_path
          ON folder_bookmarks (abs_path);

        CREATE INDEX IF NOT EXISTS idx_folder_bookmarks_recency
          ON folder_bookmarks (favorite, last_used_at DESC);

        CREATE TABLE IF NOT EXISTS connection_profiles (
          id           TEXT    NOT NULL PRIMARY KEY,
          label        TEXT,
          host         TEXT    NOT NULL,
          user         TEXT,
          port         INTEGER,
          identity_file TEXT,
          auth_mode    TEXT    NOT NULL DEFAULT 'interactive',
          favorite     INTEGER NOT NULL DEFAULT 0,
          last_used_at  INTEGER NOT NULL,
          created_at    INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_profiles_natural_key
          ON connection_profiles (host, user, port);

        CREATE INDEX IF NOT EXISTS idx_connection_profiles_recency
          ON connection_profiles (favorite, last_used_at DESC);
      `);
    },
  },
];

export function applyMigrations(db: SqliteDb): void {
  // Bootstrap: ensure _meta exists before reading schemaVersion.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get() as
    | { value: string }
    | undefined;

  let current = row ? parseInt(row.value, 10) : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    migration.up(db);
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schemaVersion', ?)").run(
      String(migration.version),
    );
    current = migration.version;
  }
}
