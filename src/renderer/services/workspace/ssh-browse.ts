/**
 * SSH browse session service — wraps `ssh.openBrowseSession`, `ssh.browseSession`,
 * and `ssh.closeBrowseSession` IPC channels.
 *
 * Exposes intent-level functions so components never import ipc/client directly.
 */

import type { DirEntry } from "../../../shared/fs/types";
import { ipcCall, ipcCallResult } from "../../ipc/client";
import type { IpcResult } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Open browse session
// ---------------------------------------------------------------------------

export interface OpenBrowseSessionArgs {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly authMode: "interactive" | "key-only";
}

export interface BrowseSessionInfo {
  readonly sessionId: string;
  readonly initialPath: string;
  /**
   * The user the session connected as. When the caller omits `user`, the main
   * process defaults to the local account name and reports it here.
   */
  readonly user: string;
}

/**
 * Open an SSH browse session.
 * Returns an IpcResult so the caller can branch on `result.ok`
 * (cancelled auth, typed failure, or success with sessionId + initialPath).
 */
export async function openSshBrowseSession(
  args: OpenBrowseSessionArgs,
): Promise<IpcResult<BrowseSessionInfo>> {
  return ipcCallResult("ssh", "openBrowseSession", {
    host: args.host,
    user: args.user,
    port: args.port,
    identityFile: args.identityFile,
    authMode: args.authMode,
  });
}

// ---------------------------------------------------------------------------
// Browse (list directory)
// ---------------------------------------------------------------------------

export interface BrowseSessionResult {
  readonly entries: readonly DirEntry[];
  readonly truncated: boolean;
}

/**
 * List the directory at `path` within an existing browse session.
 * Returns only directory and symlink entries, sorted alphabetically.
 * Throws on IPC error (caller handles retries / error state).
 */
export async function browseSshSession(
  sessionId: string,
  path: string,
): Promise<BrowseSessionResult> {
  const result = await ipcCall("ssh", "browseSession", { sessionId, path });
  const dirs = result.entries
    .filter((e) => e.type === "dir" || e.type === "symlink")
    .sort((a, b) => a.name.localeCompare(b.name));
  return { entries: dirs, truncated: result.truncated };
}

/**
 * Prefetch a directory listing for hover-based caching. Returns `null` on any
 * error — prefetch failures are silently ignored by the caller.
 */
export async function prefetchSshDirectory(
  sessionId: string,
  path: string,
): Promise<BrowseSessionResult | null> {
  try {
    return await browseSshSession(sessionId, path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Close browse session
// ---------------------------------------------------------------------------

/**
 * Close an SSH browse session.  Errors are silently swallowed — this is a
 * best-effort cleanup call, typically run on unmount.
 */
export async function closeSshBrowseSession(sessionId: string): Promise<void> {
  await ipcCall("ssh", "closeBrowseSession", { sessionId }).catch(() => {});
}
