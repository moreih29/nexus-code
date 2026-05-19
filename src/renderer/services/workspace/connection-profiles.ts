/**
 * Connection profile service — wraps `connectionProfile` IPC channel.
 *
 * Exposes intent-level functions so components never import ipc/client directly.
 */

import type { ConnectionProfile } from "../../../shared/types/entry-points";
import { type IpcResult, ipcCallResult, unwrapIpcResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** Fetch all connection profiles, sorted by most-recently-used descending. */
export async function listConnectionProfiles(): Promise<ConnectionProfile[]> {
  const list = unwrapIpcResult(await ipcCallResult("connectionProfile", "list", undefined));
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/**
 * Fetch all connection profiles without any particular sort order.
 * Use when the caller does its own sort or when it needs the raw list.
 */
export async function fetchConnectionProfiles(): Promise<ConnectionProfile[]> {
  return unwrapIpcResult(await ipcCallResult("connectionProfile", "list", undefined));
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
  unwrapIpcResult(
    await ipcCallResult("connectionProfile", "save", {
      id: args.id,
      host: args.host,
      user: args.user,
      port: args.port,
      identityFile: args.identityFile,
      authMode: args.authMode,
      label: args.label,
    }),
  );
}

/**
 * Upsert a connection profile, returning an IpcResult instead of throwing.
 *
 * Use this overload when the caller applies partial-failure policy: the save
 * is a secondary effect and a failure must not block the primary flow.
 * The caller can inspect `result.ok` and surface a non-blocking warning while
 * still proceeding with the primary action that already succeeded.
 */
export async function saveConnectionProfileResult(
  args: SaveConnectionProfileArgs,
): Promise<IpcResult<void>> {
  const raw = await ipcCallResult("connectionProfile", "save", {
    id: args.id,
    host: args.host,
    user: args.user,
    port: args.port,
    identityFile: args.identityFile,
    authMode: args.authMode,
    label: args.label,
  });
  // ipcCallResult returns IpcResult<void> for handlers whose value is undefined.
  // Cast is safe: the handler returns undefined on success.
  return raw as IpcResult<void>;
}

// ---------------------------------------------------------------------------
// Favorite toggle
// ---------------------------------------------------------------------------

/** Toggle the favorite flag for a connection profile. */
export async function setConnectionProfileFavorite(id: string, favorite: boolean): Promise<void> {
  unwrapIpcResult(await ipcCallResult("connectionProfile", "setFavorite", { id, favorite }));
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/** Remove a connection profile by id. */
export async function removeConnectionProfile(id: string): Promise<void> {
  unwrapIpcResult(await ipcCallResult("connectionProfile", "remove", { id }));
}
