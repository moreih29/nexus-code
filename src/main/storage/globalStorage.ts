import fs from "fs";
import path from "path";
import type { WorkspaceMeta } from "../../shared/types/workspace";
import { applyMigrations, type SqliteDb } from "./migrations";

// ---------------------------------------------------------------------------
// Row type — mirrors workspaces table columns 1:1
// ---------------------------------------------------------------------------

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  color_tone: string;
  pinned: number;
  category: string;
  last_opened_at: number;
}

function rowToMeta(row: WorkspaceRow): WorkspaceMeta {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    colorTone: row.color_tone as WorkspaceMeta["colorTone"],
    pinned: row.pinned === 1,
    category: row.category,
    lastOpenedAt: new Date(row.last_opened_at).toISOString(),
    tabs: [],
  };
}

// ---------------------------------------------------------------------------
// GlobalStorage — better-sqlite3 KV + workspaces table.
// Accepts any SqliteDb-compatible database so unit tests can inject
// bun:sqlite in-memory databases.
// ---------------------------------------------------------------------------

export class GlobalStorage {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(db);
  }

  /**
   * Open (or create) the global state.db at the given file path.
   * Creates parent directories as needed.
   */
  static openFile(dbPath: string): GlobalStorage {
    // Dynamic require keeps the module importable in test environments that
    // do not have better-sqlite3 available as a native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSQLite = require("better-sqlite3");
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    return new GlobalStorage(new BetterSQLite(dbPath) as SqliteDb);
  }

  close(): void {
    this.db.close();
  }

  listWorkspaces(): WorkspaceMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces ORDER BY last_opened_at DESC")
      .all() as WorkspaceRow[];
    return rows.map(rowToMeta);
  }

  addWorkspace(meta: WorkspaceMeta): void {
    this.db
      .prepare(
        `INSERT INTO workspaces
           (id, name, root_path, color_tone, pinned, category, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        meta.id,
        meta.name,
        meta.rootPath,
        meta.colorTone ?? "default",
        meta.pinned ? 1 : 0,
        meta.category ?? "DEFAULT",
        meta.lastOpenedAt ? new Date(meta.lastOpenedAt).getTime() : Date.now()
      );
  }

  updateWorkspace(id: string, partial: Partial<Omit<WorkspaceMeta, "id">>): void {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id) as WorkspaceRow | undefined;
    if (!row) {
      throw new Error(`workspace not found: ${id}`);
    }
    this.db
      .prepare(
        `UPDATE workspaces
         SET name = ?, root_path = ?, color_tone = ?, pinned = ?, category = ?, last_opened_at = ?
         WHERE id = ?`
      )
      .run(
        partial.name ?? row.name,
        partial.rootPath ?? row.root_path,
        (partial.colorTone ?? row.color_tone) as string,
        partial.pinned !== undefined ? (partial.pinned ? 1 : 0) : row.pinned,
        partial.category ?? row.category,
        partial.lastOpenedAt
          ? new Date(partial.lastOpenedAt).getTime()
          : row.last_opened_at,
        id
      );
  }

  removeWorkspace(id: string): void {
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }
}
