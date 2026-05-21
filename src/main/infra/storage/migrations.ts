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
  // Extend folder_bookmarks to support SSH remote-path bookmarks.
  //
  // Adds a `kind` discriminant (default 'local') so that all pre-existing rows
  // are automatically backfilled to kind='local' by SQLite's ADD COLUMN DEFAULT
  // — no separate UPDATE loop is required or permitted.
  //
  // The single abs_path UNIQUE index is replaced with two partial UNIQUE indexes:
  //   - local variant: (abs_path) WHERE kind='local'
  //   - ssh variant:   (connection_profile_id, abs_path) WHERE kind='ssh'
  //
  // The recency index (favorite, last_used_at DESC) is retained unchanged.
  {
    version: 5,
    up: (db) => {
      // Add kind column with DEFAULT 'local' — SQLite backfills existing rows automatically.
      if (!hasColumn(db, "folder_bookmarks", "kind")) {
        db.exec(`ALTER TABLE folder_bookmarks ADD COLUMN kind TEXT NOT NULL DEFAULT 'local';`);
      }

      // Add connection_profile_id column — NULL for local bookmarks.
      if (!hasColumn(db, "folder_bookmarks", "connection_profile_id")) {
        db.exec(`ALTER TABLE folder_bookmarks ADD COLUMN connection_profile_id TEXT NULL;`);
      }

      // Drop the old single-column abs_path unique index — it covers only the
      // local variant and would conflict with the new partial indexes below.
      db.exec(`DROP INDEX IF EXISTS idx_folder_bookmarks_abs_path;`);

      // Partial UNIQUE index for local bookmarks: one abs_path per local kind.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_bookmarks_local_path
          ON folder_bookmarks (abs_path) WHERE kind = 'local';
      `);

      // Partial UNIQUE index for SSH bookmarks: one remote abs_path per connection profile.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_bookmarks_ssh_path
          ON folder_bookmarks (connection_profile_id, abs_path) WHERE kind = 'ssh';
      `);
    },
  },
  // Add explicit sort ordering columns to workspaces so that the sidebar can
  // support user-driven drag-and-drop reordering within each pinned/unpinned group.
  //
  // Two columns are kept separate (one per group) so the ORDER BY expression can
  // pick the appropriate key per row without a self-join:
  //   - sort_order        — ordering key for the unpinned group
  //   - pinned_sort_order — ordering key for the pinned group
  //
  // Both default to 0 so that existing rows are distinguishable from explicitly
  // positioned rows.  The backfill assigns step-1024 values (1024, 2048, ...)
  // only to rows that are still at the default 0, treating non-zero values as
  // already-positioned from a previous migration run (idempotent).
  {
    version: 6,
    up: (db) => {
      const txn = (
        db as unknown as { transaction: (fn: () => void) => () => void }
      ).transaction(() => {
        // Add sort_order column — default 0 means "not yet positioned".
        if (!hasColumn(db, "workspaces", "sort_order")) {
          db.exec(
            "ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
          );
        }

        // Add pinned_sort_order column — mirrors sort_order but for the pinned group.
        if (!hasColumn(db, "workspaces", "pinned_sort_order")) {
          db.exec(
            "ALTER TABLE workspaces ADD COLUMN pinned_sort_order INTEGER NOT NULL DEFAULT 0;",
          );
        }

        // Composite index used by the sidebar list query:
        //   ORDER BY pinned DESC, (CASE pinned WHEN 1 THEN pinned_sort_order ELSE sort_order END) ASC
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_workspaces_order
            ON workspaces (pinned DESC, sort_order ASC);
        `);

        // Backfill: assign step-1024 positions to rows that have not yet been
        // positioned (both sort columns still at their DEFAULT 0).
        // Rows are sorted by last_opened_at DESC so the most-recently-used
        // workspace gets the smallest (earliest) position in its group.
        const unpositioned = db
          .prepare(
            `SELECT id, pinned
             FROM workspaces
             WHERE sort_order = 0 AND pinned_sort_order = 0
             ORDER BY last_opened_at DESC`,
          )
          .all() as { id: string; pinned: number }[];

        const updateUnpinned = db.prepare(
          "UPDATE workspaces SET sort_order = ? WHERE id = ?",
        );
        const updatePinned = db.prepare(
          "UPDATE workspaces SET pinned_sort_order = ? WHERE id = ?",
        );

        // Assign positions within each group independently so that both groups
        // start at 1024 and increment by 1024 per row.
        let unpinnedCounter = 0;
        let pinnedCounter = 0;

        for (const row of unpositioned) {
          if (row.pinned === 1) {
            pinnedCounter += 1024;
            updatePinned.run(pinnedCounter, row.id);
          } else {
            unpinnedCounter += 1024;
            updateUnpinned.run(unpinnedCounter, row.id);
          }
        }
      });

      txn();
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
