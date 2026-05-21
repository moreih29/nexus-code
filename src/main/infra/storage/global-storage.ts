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

/** Local folder bookmark (abs_path on the host machine). */
export interface LocalFolderBookmark {
  kind: "local";
  id: string;
  absPath: string;
  label: string | null;
  favorite: boolean;
  lastUsedAt: number;
  createdAt: number;
}

/** SSH remote folder bookmark — linked to a connection_profiles row. */
export interface SshFolderBookmark {
  kind: "ssh";
  id: string;
  absPath: string;
  connectionProfileId: string;
  label: string | null;
  favorite: boolean;
  lastUsedAt: number;
  createdAt: number;
}

export type FolderBookmark = LocalFolderBookmark | SshFolderBookmark;

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
  kind: string;
  connection_profile_id: string | null;
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

/**
 * Converts a database row to a FolderBookmark discriminated union value.
 * Returns null for ssh rows that are missing connection_profile_id (damaged rows).
 */
function rowToFolderBookmark(row: FolderBookmarkRow): FolderBookmark | null {
  const base = {
    id: row.id,
    absPath: row.abs_path,
    label: row.label,
    favorite: row.favorite === 1,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };

  if (row.kind === "ssh") {
    if (!row.connection_profile_id) {
      // Damaged row: ssh kind without a connection_profile_id — exclude from results.
      return null;
    }
    return { kind: "ssh", connectionProfileId: row.connection_profile_id, ...base };
  }

  return { kind: "local", ...base };
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
  sort_order: number;
  pinned_sort_order: number;
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
    sortOrder: row.sort_order,
    pinnedSortOrder: row.pinned_sort_order,
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
      .prepare(
        `SELECT * FROM workspaces
         ORDER BY pinned DESC,
                  (CASE pinned WHEN 1 THEN pinned_sort_order ELSE sort_order END) ASC`,
      )
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
           (id, name, root_path, location, color_tone, pinned, last_opened_at,
            sort_order, pinned_sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.id,
        normalized.name,
        rootPath,
        JSON.stringify(location),
        normalized.colorTone ?? "default",
        normalized.pinned ? 1 : 0,
        normalized.lastOpenedAt ? new Date(normalized.lastOpenedAt).getTime() : Date.now(),
        normalized.sortOrder,
        normalized.pinnedSortOrder,
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

  /**
   * Atomically updates sort-order columns (and optionally the pinned flag) for
   * a single workspace row. Used by WorkspaceManager.reorder() and the pin-
   * toggle path in WorkspaceManager.update() where both sort columns and the
   * pinned bit must change in the same write.
   */
  updateSortOrder(
    id: string,
    values: { sortOrder: number; pinnedSortOrder: number; pinned?: boolean },
  ): void {
    if (values.pinned !== undefined) {
      this.db
        .prepare(
          `UPDATE workspaces
           SET sort_order = ?, pinned_sort_order = ?, pinned = ?
           WHERE id = ?`,
        )
        .run(values.sortOrder, values.pinnedSortOrder, values.pinned ? 1 : 0, id);
    } else {
      this.db
        .prepare(
          `UPDATE workspaces
           SET sort_order = ?, pinned_sort_order = ?
           WHERE id = ?`,
        )
        .run(values.sortOrder, values.pinnedSortOrder, id);
    }
  }

  /**
   * Atomically repositions a workspace row within the given target group.
   *
   * The entire read-neighbours → compute-midpoint → write sequence runs inside
   * a single SQLite transaction so concurrent reads never observe a partial state.
   * When the gap between neighbours collapses to < 2 the group is rebalanced
   * first and the position is recomputed; the returned `rebalancedRows` field
   * carries the updated values for every row so the caller can broadcast a bulk
   * event.
   *
   * Cross-group moves (targetGroup differs from currentPinned) zero the source
   * group's sort column so the item no longer participates in the old group's
   * ordering.
   */
  reorderWorkspace(
    id: string,
    params: {
      currentPinned: boolean;
      targetGroup: "pinned" | "unpinned";
      beforeId?: string;
      afterId?: string;
    },
  ): {
    sortOrder: number;
    pinnedSortOrder: number;
    rebalancedRows?: Array<{ id: string; sortOrder: number; pinnedSortOrder: number }>;
  } {
    const { currentPinned, targetGroup, beforeId, afterId } = params;
    const newPinned = targetGroup === "pinned";
    const pinnedChanged = newPinned !== currentPinned;

    let rebalancedRows:
      | Array<{ id: string; sortOrder: number; pinnedSortOrder: number }>
      | undefined;
    let sortOrder = 0;
    let pinnedSortOrder = 0;

    const db = this.db;
    const txn = (
      db as unknown as { transaction: (fn: () => void) => () => void }
    ).transaction(() => {
      let positionResult = this.computeInsertPosition({
        groupKind: targetGroup,
        beforeId,
        afterId,
      });

      if ("rebalance" in positionResult) {
        rebalancedRows = this.rebalanceGroup(targetGroup);
        // After rebalance, positions are step-1024 so the gap will be ≥ 1024.
        positionResult = this.computeInsertPosition({
          groupKind: targetGroup,
          beforeId,
          afterId,
        });
        if ("rebalance" in positionResult) {
          throw new Error(`rebalance did not open a gap for workspace reorder: ${id}`);
        }
      }

      const position = positionResult.position;
      sortOrder = targetGroup === "unpinned" ? position : 0;
      pinnedSortOrder = targetGroup === "pinned" ? position : 0;

      this.updateSortOrder(id, {
        sortOrder,
        pinnedSortOrder,
        pinned: pinnedChanged ? newPinned : undefined,
      });
    });

    txn();
    return { sortOrder, pinnedSortOrder, rebalancedRows };
  }

  // -------------------------------------------------------------------------
  // Workspace sort-order helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the tail position for a new workspace appended to the given group.
   * The tail is max(existing positions) + 1024.  If the group is empty, 1024 is
   * returned so the first row gets a non-zero, rebalance-safe position.
   */
  nextTailSortOrder(groupKind: "pinned" | "unpinned"): number {
    const col = groupKind === "pinned" ? "pinned_sort_order" : "sort_order";
    const pinnedFilter = groupKind === "pinned" ? 1 : 0;
    const row = this.db
      .prepare(
        `SELECT MAX(${col}) AS max_val
         FROM workspaces
         WHERE pinned = ?`,
      )
      .get(pinnedFilter) as { max_val: number | null };
    const maxVal = row.max_val ?? 0;
    return maxVal + 1024;
  }

  /**
   * Computes the sort-order position for a workspace being inserted adjacent to
   * a reference row within the given group.
   *
   * - Both `beforeId` and `afterId` absent → tail position (max + 1024, or 1024
   *   when the group is empty).
   * - Both `beforeId` and `afterId` present → invalid; throws.
   * - Only `beforeId` present → insert immediately after that row (midpoint
   *   between beforeId and its successor; or beforeId + 1024 if beforeId is last).
   * - Only `afterId` present → insert immediately before that row (midpoint
   *   between afterId and its predecessor; or afterId − 1024 if afterId is first,
   *   but never below 1 so rebalance is signalled if the gap collapses to 0).
   *
   * Returns `{ position: number }` when a concrete position is available, or
   * `{ rebalance: true }` when the gap between neighbors has collapsed to < 2
   * and the caller must rebalance the group before retrying.
   */
  computeInsertPosition(params: {
    groupKind: "pinned" | "unpinned";
    beforeId?: string;
    afterId?: string;
  }): { position: number } | { rebalance: true } {
    const { groupKind, beforeId, afterId } = params;

    if (beforeId !== undefined && afterId !== undefined) {
      throw new Error(
        "computeInsertPosition: beforeId and afterId are mutually exclusive",
      );
    }

    const col = groupKind === "pinned" ? "pinned_sort_order" : "sort_order";
    const pinnedFilter = groupKind === "pinned" ? 1 : 0;

    // No reference → tail insertion.
    if (beforeId === undefined && afterId === undefined) {
      return { position: this.nextTailSortOrder(groupKind) };
    }

    // Insert after `beforeId`: midpoint between beforeId and its next neighbor.
    if (beforeId !== undefined) {
      const refRow = this.db
        .prepare(
          `SELECT ${col} AS pos FROM workspaces WHERE id = ? AND pinned = ?`,
        )
        .get(beforeId, pinnedFilter) as { pos: number } | undefined;

      if (!refRow) {
        throw new Error(
          `computeInsertPosition: beforeId row not found in ${groupKind} group`,
        );
      }

      const nextRow = this.db
        .prepare(
          `SELECT ${col} AS pos
           FROM workspaces
           WHERE pinned = ? AND ${col} > ?
           ORDER BY ${col} ASC
           LIMIT 1`,
        )
        .get(pinnedFilter, refRow.pos) as { pos: number } | undefined;

      if (!nextRow) {
        // beforeId is the last row; append after it.
        return { position: refRow.pos + 1024 };
      }

      const gap = nextRow.pos - refRow.pos;
      if (gap < 2) {
        return { rebalance: true };
      }

      return { position: Math.floor((refRow.pos + nextRow.pos) / 2) };
    }

    // Insert before `afterId`: midpoint between afterId and its previous neighbor.
    const refRow = this.db
      .prepare(
        `SELECT ${col} AS pos FROM workspaces WHERE id = ? AND pinned = ?`,
      )
      .get(afterId!, pinnedFilter) as { pos: number } | undefined;

    if (!refRow) {
      throw new Error(
        `computeInsertPosition: afterId row not found in ${groupKind} group`,
      );
    }

    const prevRow = this.db
      .prepare(
        `SELECT ${col} AS pos
         FROM workspaces
         WHERE pinned = ? AND ${col} < ?
         ORDER BY ${col} DESC
         LIMIT 1`,
      )
      .get(pinnedFilter, refRow.pos) as { pos: number } | undefined;

    if (!prevRow) {
      // afterId is the first row; prepend before it.
      const newPos = refRow.pos - 1024;
      if (newPos < 1) {
        return { rebalance: true };
      }
      return { position: newPos };
    }

    const gap = refRow.pos - prevRow.pos;
    if (gap < 2) {
      return { rebalance: true };
    }

    return { position: Math.floor((prevRow.pos + refRow.pos) / 2) };
  }

  /**
   * Rebalances the sort positions of all workspaces within the given group by
   * reassigning step-1024 positions (1024, 2048, 3072, …) ordered by the
   * current sort column then by id as a tiebreaker for deterministic output.
   *
   * Returns every row that was touched with its new position values so that the
   * caller can broadcast the changes to interested parties.
   */
  rebalanceGroup(
    groupKind: "pinned" | "unpinned",
  ): Array<{ id: string; sortOrder: number; pinnedSortOrder: number }> {
    const col = groupKind === "pinned" ? "pinned_sort_order" : "sort_order";
    const pinnedFilter = groupKind === "pinned" ? 1 : 0;

    const rows = this.db
      .prepare(
        `SELECT id, sort_order, pinned_sort_order
         FROM workspaces
         WHERE pinned = ?
         ORDER BY ${col} ASC, id ASC`,
      )
      .all(pinnedFilter) as { id: string; sort_order: number; pinned_sort_order: number }[];

    const updateUnpinned = this.db.prepare(
      "UPDATE workspaces SET sort_order = ? WHERE id = ?",
    );
    const updatePinned = this.db.prepare(
      "UPDATE workspaces SET pinned_sort_order = ? WHERE id = ?",
    );

    const results: Array<{ id: string; sortOrder: number; pinnedSortOrder: number }> = [];

    const db = this.db;
    const txn = (
      db as unknown as { transaction: (fn: () => void) => () => void }
    ).transaction(() => {
      rows.forEach((row, index) => {
        const newPos = (index + 1) * 1024;
        if (groupKind === "pinned") {
          updatePinned.run(newPos, row.id);
          results.push({
            id: row.id,
            sortOrder: row.sort_order,
            pinnedSortOrder: newPos,
          });
        } else {
          updateUnpinned.run(newPos, row.id);
          results.push({
            id: row.id,
            sortOrder: newPos,
            pinnedSortOrder: row.pinned_sort_order,
          });
        }
      });
    });

    txn();
    return results;
  }

  // -------------------------------------------------------------------------
  // folder_bookmarks
  // -------------------------------------------------------------------------

  /**
   * Returns all folder bookmarks ordered by recency. SSH bookmarks whose
   * linked connection_profiles row has been deleted are excluded (orphan hiding).
   */
  listFolderBookmarks(): FolderBookmark[] {
    const rows = this.db
      .prepare(
        `SELECT b.*
         FROM folder_bookmarks b
         LEFT JOIN connection_profiles p ON b.connection_profile_id = p.id
         WHERE b.kind = 'local' OR p.id IS NOT NULL
         ORDER BY b.favorite DESC, b.last_used_at DESC`,
      )
      .all() as FolderBookmarkRow[];
    return rows.map(rowToFolderBookmark).filter((b): b is FolderBookmark => b !== null);
  }

  /**
   * Upsert a folder bookmark by its natural key (local: abs_path; ssh: connection_profile_id +
   * abs_path). Updates last_used_at on conflict. Evicts the oldest non-favorite, non-orphan rows
   * beyond ENTRY_POINT_RECENT_CAP in the same transaction.
   *
   * The conflict target predicate matches each partial UNIQUE index so that SQLite
   * can route the conflict correctly without triggering a PK violation on the
   * unrelated variant's index.
   */
  recordFolderBookmark(params: {
    id: string;
    absPath: string;
    label?: string | null;
    kind?: "local" | "ssh";
    connectionProfileId?: string;
  }): void {
    const now = Date.now();
    const db = this.db;
    const kind = params.kind ?? "local";

    // better-sqlite3 exposes .transaction(); the SqliteDb interface used in
    // tests (bun:sqlite Database) also exposes .transaction() with the same
    // synchronous semantics, so this cast is safe in both runtimes.
    const txn = (db as unknown as { transaction: (fn: () => void) => () => void }).transaction(
      () => {
        if (kind === "ssh") {
          // SSH variant — conflict target is the partial index on (connection_profile_id, abs_path).
          db.prepare(
            `INSERT INTO folder_bookmarks
               (id, abs_path, kind, connection_profile_id, label, favorite, last_used_at, created_at)
             VALUES (?, ?, 'ssh', ?, ?, 0, ?, ?)
             ON CONFLICT (connection_profile_id, abs_path) WHERE kind = 'ssh'
               DO UPDATE SET last_used_at = excluded.last_used_at`,
          ).run(
            params.id,
            params.absPath,
            params.connectionProfileId ?? null,
            params.label ?? null,
            now,
            now,
          );
        } else {
          // Local variant — conflict target is the partial index on (abs_path).
          db.prepare(
            `INSERT INTO folder_bookmarks
               (id, abs_path, kind, connection_profile_id, label, favorite, last_used_at, created_at)
             VALUES (?, ?, 'local', NULL, ?, 0, ?, ?)
             ON CONFLICT (abs_path) WHERE kind = 'local'
               DO UPDATE SET last_used_at = excluded.last_used_at`,
          ).run(params.id, params.absPath, params.label ?? null, now, now);
        }

        // Evict non-favorite, non-orphan rows beyond the cap (oldest first).
        // The orphan filter mirrors listFolderBookmarks so that hidden ssh rows
        // do not occupy eviction cap slots and cause the visible list to shrink.
        db.prepare(
          `DELETE FROM folder_bookmarks
           WHERE favorite = 0
             AND id NOT IN (
               SELECT b.id
               FROM folder_bookmarks b
               LEFT JOIN connection_profiles p ON b.connection_profile_id = p.id
               WHERE (b.kind = 'local' OR p.id IS NOT NULL)
                 AND b.favorite = 0
               ORDER BY b.last_used_at DESC
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
