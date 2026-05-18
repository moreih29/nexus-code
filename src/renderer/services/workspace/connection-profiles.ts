/**
 * Connection profile service — wraps `connectionProfile` IPC channel.
 *
 * Exposes intent-level functions so components never import ipc/client directly.
 */

import type { ConnectionProfile } from "../../../shared/types/entry-points";
import { ipcCall } from "../../ipc/client";

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** Fetch all connection profiles, sorted by most-recently-used descending. */
export async function listConnectionProfiles(): Promise<ConnectionProfile[]> {
  const list = await ipcCall("connectionProfile", "list", undefined);
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/**
 * Fetch all connection profiles without any particular sort order.
 * Use when the caller does its own sort or when it needs the raw list.
 */
export async function fetchConnectionProfiles(): Promise<ConnectionProfile[]> {
  return ipcCall("connectionProfile", "list", undefined);
}

// ---------------------------------------------------------------------------
// Save (upsert)
// ---------------------------------------------------------------------------

export interface SaveConnectionProfileArgs {
  readonly id: string;
  readonly host: string;
  readonly user: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly authMode: "interactive" | "key-only";
  readonly label?: string;
}

/** Upsert a connection profile (creates or updates lastUsedAt). */
export async function saveConnectionProfile(args: SaveConnectionProfileArgs): Promise<void> {
  await ipcCall("connectionProfile", "save", {
    id: args.id,
    host: args.host,
    user: args.user,
    port: args.port,
    identityFile: args.identityFile,
    authMode: args.authMode,
    label: args.label,
  });
}

// ---------------------------------------------------------------------------
// Favorite toggle
// ---------------------------------------------------------------------------

/** Toggle the favorite flag for a connection profile. */
export async function setConnectionProfileFavorite(id: string, favorite: boolean): Promise<void> {
  await ipcCall("connectionProfile", "setFavorite", { id, favorite });
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/** Remove a connection profile by id. */
export async function removeConnectionProfile(id: string): Promise<void> {
  await ipcCall("connectionProfile", "remove", { id });
}
