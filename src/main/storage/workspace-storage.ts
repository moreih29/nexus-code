import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_GIT_PANEL_STATE,
  type GitExpandedGroups,
  type GitExpandedTreeNodes,
  type GitPanelState,
  GitPanelStateSchema,
  type GitPanelStateUpdate,
} from "../../shared/types/git";
import {
  DEFAULT_VIEW_OPTIONS_BY_PANEL,
  type PanelKind,
  type PanelViewOptions,
  PanelViewOptionsSchema,
} from "../../shared/types/panel";
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
];

const GIT_PANEL_COMMIT_DRAFT_KEY = "commitDraft";
const GIT_PANEL_EXPANDED_GROUPS_KEY = "expandedGroups";
const GIT_PANEL_EXPANDED_TREE_NODES_KEY = "expandedTreeNodes";

function defaultGitExpandedGroups(): GitExpandedGroups {
  return { ...DEFAULT_GIT_PANEL_STATE.expandedGroups };
}

function defaultGitExpandedTreeNodes(): GitExpandedTreeNodes {
  return {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
  };
}

function defaultGitPanelState(): GitPanelState {
  return {
    commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
    expandedGroups: defaultGitExpandedGroups(),
    expandedTreeNodes: defaultGitExpandedTreeNodes(),
  };
}

function parseGitExpandedGroups(
  workspaceId: string,
  raw: string | undefined,
): GitExpandedGroups | null {
  if (raw === undefined) {
    return defaultGitExpandedGroups();
  }

  try {
    const state = GitPanelStateSchema.parse({
      commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
      expandedGroups: JSON.parse(raw) as unknown,
      expandedTreeNodes: DEFAULT_GIT_PANEL_STATE.expandedTreeNodes,
    });
    return state.expandedGroups;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state expandedGroups for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return null;
  }
}

function parseGitExpandedTreeNodes(
  workspaceId: string,
  raw: string | undefined,
): GitExpandedTreeNodes {
  if (raw === undefined) {
    return defaultGitExpandedTreeNodes();
  }

  try {
    const state = GitPanelStateSchema.parse({
      commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
      expandedGroups: DEFAULT_GIT_PANEL_STATE.expandedGroups,
      expandedTreeNodes: JSON.parse(raw) as unknown,
    });
    return state.expandedTreeNodes;
  } catch (err) {
    console.warn(
      `[WorkspaceStorage] Invalid git_panel_state expandedTreeNodes for workspace ${workspaceId}; using defaults.`,
      err,
    );
    return defaultGitExpandedTreeNodes();
  }
}

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
//   to backup-{timestamp} and a fresh directory is created. Intended as a
//   developer escape hatch for corrupt-state recovery; the rename (rather than
//   delete) preserves the prior state for postmortem inspection.
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
   * Honors NEXUS_RESET_STORAGE=1 as a developer escape hatch — see the
   * file-level comment for the rename-to-backup semantics.
   */
  openForWorkspace(workspaceId: string): void {
    if (this.entries.has(workspaceId)) {
      return;
    }

    const workspaceDir = path.join(this.baseDir, workspaceId);

    // NEXUS_RESET_STORAGE=1 developer escape hatch — see the file-level comment.
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

  /**
   * Returns the persisted Source Control panel state for a workspace.
   * Missing rows fall back to defaults; invalid expandedGroups JSON logs and
   * falls back to the default panel state without throwing.
   */
  getGitPanelState(workspaceId: string): GitPanelState {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }

    const rows = entry.db.prepare("SELECT key, value FROM git_panel_state").all() as {
      key: string;
      value: string;
    }[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const expandedGroups = parseGitExpandedGroups(
      workspaceId,
      values.get(GIT_PANEL_EXPANDED_GROUPS_KEY),
    );
    if (expandedGroups === null) {
      return defaultGitPanelState();
    }

    const expandedTreeNodes = parseGitExpandedTreeNodes(
      workspaceId,
      values.get(GIT_PANEL_EXPANDED_TREE_NODES_KEY),
    );

    const state = {
      commitDraft: values.get(GIT_PANEL_COMMIT_DRAFT_KEY) ?? DEFAULT_GIT_PANEL_STATE.commitDraft,
      expandedGroups,
      expandedTreeNodes,
    };
    const parsed = GitPanelStateSchema.safeParse(state);
    if (!parsed.success) {
      console.warn(
        `[WorkspaceStorage] Invalid git_panel_state for workspace ${workspaceId}; using defaults.`,
        parsed.error,
      );
      return defaultGitPanelState();
    }
    return parsed.data;
  }

  /**
   * Persists partial Source Control panel state for a workspace.
   * Only provided keys are replaced so callers can update the draft or group
   * expansion state independently.
   */
  setGitPanelState(workspaceId: string, state: GitPanelStateUpdate): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }

    const parsed = GitPanelStateSchema.partial().parse(state);
    const ins = entry.db.prepare(
      "INSERT OR REPLACE INTO git_panel_state (key, value) VALUES (?, ?)",
    );
    entry.db.exec("BEGIN");
    try {
      if (parsed.commitDraft !== undefined) {
        ins.run(GIT_PANEL_COMMIT_DRAFT_KEY, parsed.commitDraft);
      }
      if (parsed.expandedGroups !== undefined) {
        ins.run(GIT_PANEL_EXPANDED_GROUPS_KEY, JSON.stringify(parsed.expandedGroups));
      }
      if (parsed.expandedTreeNodes !== undefined) {
        ins.run(GIT_PANEL_EXPANDED_TREE_NODES_KEY, JSON.stringify(parsed.expandedTreeNodes));
      }
      entry.db.exec("COMMIT");
    } catch (err) {
      entry.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Returns the persisted view options for the given panel kind in a workspace.
   * Falls back to DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] when the row is
   * absent (fresh workspace or newly introduced panel kind).
   */
  getPanelViewOptions(workspaceId: string, panelKind: PanelKind): PanelViewOptions {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }

    const row = entry.db
      .prepare(
        "SELECT view_mode, compact_folders FROM panel_view_options WHERE panel_kind = ?",
      )
      .get(panelKind) as { view_mode: string; compact_folders: number } | undefined;

    if (!row) {
      return { ...DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] };
    }

    const parsed = PanelViewOptionsSchema.safeParse({
      viewMode: row.view_mode,
      compactFolders: row.compact_folders !== 0,
    });
    if (!parsed.success) {
      console.warn(
        `[WorkspaceStorage] Invalid panel_view_options for workspace ${workspaceId} panel ${panelKind}; using defaults.`,
        parsed.error,
      );
      return { ...DEFAULT_VIEW_OPTIONS_BY_PANEL[panelKind] };
    }
    return parsed.data;
  }

  /**
   * Persists partial view options for the given panel kind.
   * Reads the current persisted row (or defaults) and merges the provided
   * partial before writing, so callers may update viewMode or compactFolders
   * independently. Uses INSERT OR REPLACE to upsert the row atomically.
   */
  setPanelViewOptions(
    workspaceId: string,
    panelKind: PanelKind,
    partial: Partial<PanelViewOptions>,
  ): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      throw new Error(`workspace storage not open: ${workspaceId}`);
    }

    const current = this.getPanelViewOptions(workspaceId, panelKind);
    const merged = PanelViewOptionsSchema.parse({ ...current, ...partial });

    entry.db
      .prepare(
        `INSERT OR REPLACE INTO panel_view_options (panel_kind, view_mode, compact_folders)
         VALUES (?, ?, ?)`,
      )
      .run(panelKind, merged.viewMode, merged.compactFolders ? 1 : 0);
  }
}
