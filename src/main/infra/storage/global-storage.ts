import fs from "node:fs";
import path from "node:path";
import {
  rootPathFromLocation,
  type WorkspaceLocation,
  WorkspaceLocationSchema,
  type WorkspaceMeta,
  WorkspaceMetaSchema,
  WorkspaceSshLocationSchema,
  type WorkspaceTask,
  WorkspaceTaskSchema,
} from "../../../shared/types/workspace";
import { toWorkspaceColor } from "../../../shared/types/workspace-color";
import { applyMigrations, type SqliteDb } from "./migrations";

const ENTRY_POINT_RECENT_CAP = 20;

export interface LocalFolderBookmark {
  kind: "local";
  id: string;
  absPath: string;
  label: string | null;
  favorite: boolean;
  lastUsedAt: number;
  createdAt: number;
}

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
  user: string;
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

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  location: string | null;
  color: string;
  pinned: number;
  last_opened_at: number;
  sort_order: number;
  pinned_sort_order: number;
  task: string | null;
}

function fallbackLocalLocation(rootPath: string): WorkspaceLocation {
  return { kind: "local", rootPath };
}

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
    return salvageSshLocation(parsedJson) ?? fallbackLocalLocation(row.root_path);
  }

  return parsedLocation.data;
}

function storedLocationIsValid(row: WorkspaceRow): boolean {
  if (!row.location) return true;
  try {
    return WorkspaceLocationSchema.safeParse(JSON.parse(row.location)).success;
  } catch {
    return false;
  }
}

function salvageSshLocation(value: unknown): WorkspaceLocation | null {
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Record<string, unknown>;
  if (stored.kind !== "ssh") return null;
  let salvaged: Record<string, unknown> = {
    kind: "ssh",
    host: stored.host,
    remotePath: stored.remotePath,
  };
  if (!WorkspaceSshLocationSchema.safeParse(salvaged).success) return null;
  for (const [key, field] of Object.entries(stored)) {
    if (key in salvaged) continue;
    const candidate = { ...salvaged, [key]: field };
    if (WorkspaceSshLocationSchema.safeParse(candidate).success) salvaged = candidate;
  }
  return WorkspaceSshLocationSchema.parse(salvaged);
}

function rowTask(row: WorkspaceRow): WorkspaceTask | undefined {
  if (!row.task) return undefined;
  try {
    const parsed = WorkspaceTaskSchema.safeParse(JSON.parse(row.task));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizeLocation(location: WorkspaceLocation): WorkspaceLocation {
  return WorkspaceLocationSchema.parse(location);
}

function rowToMeta(row: WorkspaceRow): WorkspaceMeta {
  const location = rowLocation(row);
  return WorkspaceMetaSchema.parse({
    id: row.id,
    name: row.name,
    location,
    rootPath: rootPathFromLocation(location),
    color: toWorkspaceColor(row.color),
    pinned: row.pinned === 1,
    lastOpenedAt: new Date(row.last_opened_at).toISOString(),
    tabs: [],
    sortOrder: row.sort_order,
    pinnedSortOrder: row.pinned_sort_order,
    task: rowTask(row),
  });
}

export class GlobalStorage {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(db);
  }

  static openFile(dbPath: string): GlobalStorage {
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
           (id, name, root_path, location, color, pinned, last_opened_at,
            sort_order, pinned_sort_order, task)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalized.id,
        normalized.name,
        rootPath,
        JSON.stringify(location),
        normalized.color,
        normalized.pinned ? 1 : 0,
        normalized.lastOpenedAt ? new Date(normalized.lastOpenedAt).getTime() : Date.now(),
        normalized.sortOrder,
        normalized.pinnedSortOrder,
        normalized.task ? JSON.stringify(normalized.task) : null,
      );
  }

  updateWorkspace(id: string, partial: Partial<Omit<WorkspaceMeta, "id">>): void {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | WorkspaceRow
      | undefined;
    if (!row) {
      throw new Error(`workspace not found: ${id}`);
    }
    const changedLocation =
      partial.location ?? (partial.rootPath ? fallbackLocalLocation(partial.rootPath) : null);
    let locationJson = row.location;
    let rootPath = row.root_path;
    if (changedLocation || storedLocationIsValid(row)) {
      const normalizedLocation = normalizeLocation(changedLocation ?? rowLocation(row));
      locationJson = JSON.stringify(normalizedLocation);
      rootPath = rootPathFromLocation(normalizedLocation);
    }
    this.db
      .prepare(
        `UPDATE workspaces
         SET name = ?, root_path = ?, location = ?, color = ?, pinned = ?, last_opened_at = ?
         WHERE id = ?`,
      )
      .run(
        partial.name ?? row.name,
        rootPath,
        locationJson,
        partial.color ?? toWorkspaceColor(row.color),
        partial.pinned !== undefined ? (partial.pinned ? 1 : 0) : row.pinned,
        partial.lastOpenedAt ? new Date(partial.lastOpenedAt).getTime() : row.last_opened_at,
        id,
      );
  }

  removeWorkspace(id: string): void {
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }

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
    const txn = (db as unknown as { transaction: (fn: () => void) => () => void }).transaction(
      () => {
        let positionResult = this.computeInsertPosition({
          groupKind: targetGroup,
          beforeId,
          afterId,
        });

        if ("rebalance" in positionResult) {
          rebalancedRows = this.rebalanceGroup(targetGroup);
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
      },
    );

    txn();
    return { sortOrder, pinnedSortOrder, rebalancedRows };
  }

  nextTailSortOrder(groupKind: "pinned" | "unpinned"): number {
    const col = groupKind === "pinned" ? "pinned_sort_order" : "sort_order";
    const pinnedFilter = groupKind === "pinned" ? 1 : 0;
    const row = this.db
      .prepare(
        `SELECT MAX(${col}) AS max_val
         FROM workspaces
         WHERE pinned = ? AND task IS NULL`,
      )
      .get(pinnedFilter) as { max_val: number | null };
    const maxVal = row.max_val ?? 0;
    return maxVal + 1024;
  }

  computeInsertPosition(params: {
    groupKind: "pinned" | "unpinned";
    beforeId?: string;
    afterId?: string;
  }): { position: number } | { rebalance: true } {
    const { groupKind, beforeId, afterId } = params;

    if (beforeId !== undefined && afterId !== undefined) {
      throw new Error("computeInsertPosition: beforeId and afterId are mutually exclusive");
    }

    const col = groupKind === "pinned" ? "pinned_sort_order" : "sort_order";
    const pinnedFilter = groupKind === "pinned" ? 1 : 0;

    if (beforeId !== undefined) {
      const refRow = this.db
        .prepare(`SELECT ${col} AS pos FROM workspaces WHERE id = ? AND pinned = ?`)
        .get(beforeId, pinnedFilter) as { pos: number } | undefined;

      if (!refRow) {
        throw new Error(`computeInsertPosition: beforeId row not found in ${groupKind} group`);
      }

      const prevRow = this.db
        .prepare(
          `SELECT ${col} AS pos
           FROM workspaces
           WHERE pinned = ? AND task IS NULL AND ${col} < ?
           ORDER BY ${col} DESC
           LIMIT 1`,
        )
        .get(pinnedFilter, refRow.pos) as { pos: number } | undefined;

      if (!prevRow) {
        const newPos = Math.floor(refRow.pos / 2);
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

    if (afterId === undefined) {
      return { position: this.nextTailSortOrder(groupKind) };
    }

    const refRow = this.db
      .prepare(`SELECT ${col} AS pos FROM workspaces WHERE id = ? AND pinned = ?`)
      .get(afterId, pinnedFilter) as { pos: number } | undefined;

    if (!refRow) {
      throw new Error(`computeInsertPosition: afterId row not found in ${groupKind} group`);
    }

    const nextRow = this.db
      .prepare(
        `SELECT ${col} AS pos
         FROM workspaces
         WHERE pinned = ? AND task IS NULL AND ${col} > ?
         ORDER BY ${col} ASC
         LIMIT 1`,
      )
      .get(pinnedFilter, refRow.pos) as { pos: number } | undefined;

    if (!nextRow) {
      return { position: refRow.pos + 1024 };
    }

    const gap = nextRow.pos - refRow.pos;
    if (gap < 2) {
      return { rebalance: true };
    }

    return { position: Math.floor((refRow.pos + nextRow.pos) / 2) };
  }

  rebalanceGroup(
    groupKind: "pinned" | "unpinned",
  ): Array<{ id: string; sortOrder: number; pinnedSortOrder: number }> {
    const col = groupKind === "pinned" ? "pinned_sort_order" : "sort_order";
    const pinnedFilter = groupKind === "pinned" ? 1 : 0;

    const rows = this.db
      .prepare(
        `SELECT id, sort_order, pinned_sort_order
         FROM workspaces
         WHERE pinned = ? AND task IS NULL
         ORDER BY ${col} ASC, id ASC`,
      )
      .all(pinnedFilter) as { id: string; sort_order: number; pinned_sort_order: number }[];

    const updateUnpinned = this.db.prepare("UPDATE workspaces SET sort_order = ? WHERE id = ?");
    const updatePinned = this.db.prepare(
      "UPDATE workspaces SET pinned_sort_order = ? WHERE id = ?",
    );

    const results: Array<{ id: string; sortOrder: number; pinnedSortOrder: number }> = [];

    const db = this.db;
    const txn = (db as unknown as { transaction: (fn: () => void) => () => void }).transaction(
      () => {
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
      },
    );

    txn();
    return results;
  }

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

    const txn = (db as unknown as { transaction: (fn: () => void) => () => void }).transaction(
      () => {
        if (kind === "ssh") {
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
          db.prepare(
            `INSERT INTO folder_bookmarks
               (id, abs_path, kind, connection_profile_id, label, favorite, last_used_at, created_at)
             VALUES (?, ?, 'local', NULL, ?, 0, ?, ?)
             ON CONFLICT (abs_path) WHERE kind = 'local'
               DO UPDATE SET last_used_at = excluded.last_used_at`,
          ).run(params.id, params.absPath, params.label ?? null, now, now);
        }

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

  listConnectionProfiles(): ConnectionProfile[] {
    const rows = this.db
      .prepare(`SELECT * FROM connection_profiles ORDER BY favorite DESC, last_used_at DESC`)
      .all() as ConnectionProfileRow[];
    return rows.map(rowToConnectionProfile);
  }

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
