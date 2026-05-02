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

// M0: version 1 — create _meta and workspaces tables.
export const MIGRATIONS: Migration[] = [
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
