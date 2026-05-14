import fs from "node:fs";
import path from "node:path";
import {
  rootPathFromLocation,
  type WorkspaceLocation,
  WorkspaceLocationSchema,
  type WorkspaceMeta,
  WorkspaceMetaSchema,
} from "../../../shared/types/workspace";
import { applyMigrations, type SqliteDb } from "./migrations";

// ---------------------------------------------------------------------------
// Row type — mirrors workspaces table columns 1:1
// ---------------------------------------------------------------------------

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  location: string | null;
  color_tone: string;
  pinned: number;
  last_opened_at: number;
}

/**
 * Builds the local location fallback used for legacy or invalid stored rows.
 */
function fallbackLocalLocation(rootPath: string): WorkspaceLocation {
  return { kind: "local", rootPath };
}

/**
 * Parses a stored location JSON blob, falling back to root_path for old rows.
 */
function rowLocation(row: WorkspaceRow): WorkspaceLocation {
  if (!row.location) {
    return fallbackLocalLocation(row.root_path);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(row.location);
  } catch {
    return fallbackLocalLocation(row.root_path);
  }

  const parsedLocation = WorkspaceLocationSchema.safeParse(parsedJson);
  if (!parsedLocation.success) {
    return fallbackLocalLocation(row.root_path);
  }

  return parsedLocation.data;
}

function normalizeLocation(location: WorkspaceLocation): WorkspaceLocation {
  return WorkspaceLocationSchema.parse(location);
}

/**
 * Converts a database row into the normalized workspace metadata shape.
 */
function rowToMeta(row: WorkspaceRow): WorkspaceMeta {
  const location = rowLocation(row);
  return WorkspaceMetaSchema.parse({
    id: row.id,
    name: row.name,
    location,
    rootPath: rootPathFromLocation(location),
    colorTone: row.color_tone as WorkspaceMeta["colorTone"],
    pinned: row.pinned === 1,
    lastOpenedAt: new Date(row.last_opened_at).toISOString(),
    tabs: [],
  });
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
    const normalized = WorkspaceMetaSchema.parse(meta);
    const location = normalizeLocation(normalized.location);
    const rootPath = rootPathFromLocation(location);
    this.db
      .prepare(
        `INSERT INTO workspaces
           (id, name, root_path, location, color_tone, pinned, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.id,
        normalized.name,
        rootPath,
        JSON.stringify(location),
        normalized.colorTone ?? "default",
        normalized.pinned ? 1 : 0,
        normalized.lastOpenedAt ? new Date(normalized.lastOpenedAt).getTime() : Date.now(),
      );
  }

  updateWorkspace(id: string, partial: Partial<Omit<WorkspaceMeta, "id">>): void {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | WorkspaceRow
      | undefined;
    if (!row) {
      throw new Error(`workspace not found: ${id}`);
    }
    const location =
      partial.location ??
      (partial.rootPath ? fallbackLocalLocation(partial.rootPath) : rowLocation(row));
    const normalizedLocation = normalizeLocation(location);
    const rootPath = rootPathFromLocation(normalizedLocation);
    this.db
      .prepare(
        `UPDATE workspaces
         SET name = ?, root_path = ?, location = ?, color_tone = ?, pinned = ?, last_opened_at = ?
         WHERE id = ?`,
      )
      .run(
        partial.name ?? row.name,
        rootPath,
        JSON.stringify(normalizedLocation),
        (partial.colorTone ?? row.color_tone) as string,
        partial.pinned !== undefined ? (partial.pinned ? 1 : 0) : row.pinned,
        partial.lastOpenedAt ? new Date(partial.lastOpenedAt).getTime() : row.last_opened_at,
        id,
      );
  }

  removeWorkspace(id: string): void {
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }
}
