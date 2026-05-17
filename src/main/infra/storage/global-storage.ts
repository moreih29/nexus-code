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
// Entry-point persistence — folder_bookmarks + connection_profiles
// ---------------------------------------------------------------------------

/** Non-secret cap for recent (non-favorite) rows in each entry-point table. */
const ENTRY_POINT_RECENT_CAP = 20;

export interface FolderBookmark {
  id: string;
  absPath: string;
  label: string | null;
  favorite: boolean;
  lastUsedAt: number;
  createdAt: number;
}

export interface ConnectionProfile {
  id: string;
  label: string | null;
  host: string;
  /** Normalized: never null/undefined — defaults to the resolved login at write time. */
  user: string;
  /** Normalized: never null/undefined — defaults to 22 at write time. */
  port: number;
  identityFile: string | null;
  authMode: string;
  favorite: boolean;
  lastUsedAt: number;
  createdAt: number;
}

interface FolderBookmarkRow {
  id: string;
  abs_path: string;
  label: string | null;
  favorite: number;
  last_used_at: number;
  created_at: number;
}

interface ConnectionProfileRow {
  id: string;
  label: string | null;
  host: string;
  user: string;
  port: number;
  identity_file: string | null;
  auth_mode: string;
  favorite: number;
  last_used_at: number;
  created_at: number;
}

function rowToFolderBookmark(row: FolderBookmarkRow): FolderBookmark {
  return {
    id: row.id,
    absPath: row.abs_path,
    label: row.label,
    favorite: row.favorite === 1,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

function rowToConnectionProfile(row: ConnectionProfileRow): ConnectionProfile {
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    user: row.user,
    port: row.port,
    identityFile: row.identity_file,
    authMode: row.auth_mode,
    favorite: row.favorite === 1,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

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

  // -------------------------------------------------------------------------
  // folder_bookmarks
  // -------------------------------------------------------------------------

  listFolderBookmarks(): FolderBookmark[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM folder_bookmarks ORDER BY favorite DESC, last_used_at DESC`,
      )
      .all() as FolderBookmarkRow[];
    return rows.map(rowToFolderBookmark);
  }

  /**
   * Upsert a folder bookmark by its natural key (abs_path).
   * Updates last_used_at on conflict. Evicts oldest non-favorite rows beyond
   * ENTRY_POINT_RECENT_CAP in the same transaction.
   */
  recordFolderBookmark(params: {
    id: string;
    absPath: string;
    label?: string | null;
  }): void {
    const now = Date.now();
    const db = this.db;

    // better-sqlite3 exposes .transaction(); the SqliteDb interface used in
    // tests (bun:sqlite Database) also exposes .transaction() with the same
    // synchronous semantics, so this cast is safe in both runtimes.
    const txn = (db as unknown as { transaction: (fn: () => void) => () => void }).transaction(
      () => {
        db.prepare(
          `INSERT INTO folder_bookmarks (id, abs_path, label, favorite, last_used_at, created_at)
           VALUES (?, ?, ?, 0, ?, ?)
           ON CONFLICT (abs_path) DO UPDATE SET last_used_at = excluded.last_used_at`,
        ).run(params.id, params.absPath, params.label ?? null, now, now);

        // Evict non-favorite rows beyond the cap (oldest first).
        db.prepare(
          `DELETE FROM folder_bookmarks
           WHERE favorite = 0
             AND id NOT IN (
               SELECT id FROM folder_bookmarks
               WHERE favorite = 0
               ORDER BY last_used_at DESC
               LIMIT ?
             )`,
        ).run(ENTRY_POINT_RECENT_CAP);
      },
    );
    txn();
  }

  setFolderBookmarkFavorite(id: string, favorite: boolean): void {
    this.db
      .prepare(`UPDATE folder_bookmarks SET favorite = ? WHERE id = ?`)
      .run(favorite ? 1 : 0, id);
  }

  removeFolderBookmark(id: string): void {
    this.db.prepare(`DELETE FROM folder_bookmarks WHERE id = ?`).run(id);
  }

  // -------------------------------------------------------------------------
  // connection_profiles
  // -------------------------------------------------------------------------

  listConnectionProfiles(): ConnectionProfile[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM connection_profiles ORDER BY favorite DESC, last_used_at DESC`,
      )
      .all() as ConnectionProfileRow[];
    return rows.map(rowToConnectionProfile);
  }

  /**
   * Upsert a connection profile by its natural key (host, user, port).
   * Port defaults to 22 and user must be provided as a resolved login so the
   * UNIQUE INDEX never sees null-distinct collisions.
   * Updates last_used_at on conflict. Evicts oldest non-favorite rows beyond
   * ENTRY_POINT_RECENT_CAP in the same transaction.
   */
  recordConnectionProfile(params: {
    id: string;
    label?: string | null;
    host: string;
    user: string;
    port?: number | null;
    identityFile?: string | null;
    authMode?: string;
  }): void {
    const now = Date.now();
    const db = this.db;

    // Normalize to prevent null-distinct issues on the UNIQUE INDEX.
    const normalizedPort = params.port ?? 22;
    const normalizedUser = params.user;
    const normalizedAuthMode = params.authMode ?? "interactive";

    const txn = (db as unknown as { transaction: (fn: () => void) => () => void }).transaction(
      () => {
        db.prepare(
          `INSERT INTO connection_profiles
             (id, label, host, user, port, identity_file, auth_mode, favorite, last_used_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT (host, user, port) DO UPDATE SET last_used_at = excluded.last_used_at`,
        ).run(
          params.id,
          params.label ?? null,
          params.host,
          normalizedUser,
          normalizedPort,
          params.identityFile ?? null,
          normalizedAuthMode,
          now,
          now,
        );

        // Evict non-favorite rows beyond the cap (oldest first).
        db.prepare(
          `DELETE FROM connection_profiles
           WHERE favorite = 0
             AND id NOT IN (
               SELECT id FROM connection_profiles
               WHERE favorite = 0
               ORDER BY last_used_at DESC
               LIMIT ?
             )`,
        ).run(ENTRY_POINT_RECENT_CAP);
      },
    );
    txn();
  }

  setConnectionProfileFavorite(id: string, favorite: boolean): void {
    this.db
      .prepare(`UPDATE connection_profiles SET favorite = ? WHERE id = ?`)
      .run(favorite ? 1 : 0, id);
  }

  removeConnectionProfile(id: string): void {
    this.db.prepare(`DELETE FROM connection_profiles WHERE id = ?`).run(id);
  }
}
