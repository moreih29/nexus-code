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

function hasColumn(db: SqliteDb, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  return columns.some((column) => column.name === columnName);
}

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
  {
    version: 2,
    up: (db) => {
      db.exec(`ALTER TABLE workspaces DROP COLUMN category;`);
    },
  },
  {
    version: 3,
    up: migrateWorkspaceLocations,
  },
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
  {
    version: 5,
    up: (db) => {
      if (!hasColumn(db, "folder_bookmarks", "kind")) {
        db.exec(`ALTER TABLE folder_bookmarks ADD COLUMN kind TEXT NOT NULL DEFAULT 'local';`);
      }

      if (!hasColumn(db, "folder_bookmarks", "connection_profile_id")) {
        db.exec(`ALTER TABLE folder_bookmarks ADD COLUMN connection_profile_id TEXT NULL;`);
      }

      db.exec(`DROP INDEX IF EXISTS idx_folder_bookmarks_abs_path;`);

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_bookmarks_local_path
          ON folder_bookmarks (abs_path) WHERE kind = 'local';
      `);

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_bookmarks_ssh_path
          ON folder_bookmarks (connection_profile_id, abs_path) WHERE kind = 'ssh';
      `);
    },
  },
  {
    version: 6,
    up: (db) => {
      const txn = (db as unknown as { transaction: (fn: () => void) => () => void }).transaction(
        () => {
          if (!hasColumn(db, "workspaces", "sort_order")) {
            db.exec("ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;");
          }

          if (!hasColumn(db, "workspaces", "pinned_sort_order")) {
            db.exec(
              "ALTER TABLE workspaces ADD COLUMN pinned_sort_order INTEGER NOT NULL DEFAULT 0;",
            );
          }

          db.exec(`
          CREATE INDEX IF NOT EXISTS idx_workspaces_order
            ON workspaces (pinned DESC, sort_order ASC);
        `);

          const unpositioned = db
            .prepare(
              `SELECT id, pinned
             FROM workspaces
             WHERE sort_order = 0 AND pinned_sort_order = 0
             ORDER BY last_opened_at DESC`,
            )
            .all() as { id: string; pinned: number }[];

          const updateUnpinned = db.prepare("UPDATE workspaces SET sort_order = ? WHERE id = ?");
          const updatePinned = db.prepare(
            "UPDATE workspaces SET pinned_sort_order = ? WHERE id = ?",
          );

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
        },
      );

      txn();
    },
  },
  {
    version: 7,
    up: (db) => {
      if (!hasColumn(db, "workspaces", "task")) {
        db.exec("ALTER TABLE workspaces ADD COLUMN task TEXT NULL;");
      }
    },
  },
  {
    version: 8,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_spans (
          id                  INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          workspace_id        TEXT    NOT NULL,
          tab_id              TEXT    NOT NULL,
          state               TEXT    NOT NULL,
          start_at            INTEGER NOT NULL,
          end_at              INTEGER,
          target_workspace_id TEXT,
          target_tab_id       TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_session_spans_workspace
          ON session_spans (workspace_id, start_at);
      `);
    },
  },
  {
    version: 9,
    up: (db) => {
      db.exec(`ALTER TABLE session_spans ADD COLUMN agent TEXT`);
    },
  },
  {
    version: 10,
    up: (db) => {
      if (!hasColumn(db, "workspaces", "color")) {
        db.exec("ALTER TABLE workspaces ADD COLUMN color TEXT NOT NULL DEFAULT 'auto';");
      }
    },
  },
];

export function applyMigrations(db: SqliteDb): void {
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
