/**
 * SSH browse session service — wraps `ssh.openBrowseSession`, `ssh.browseSession`,
 * and `ssh.closeBrowseSession` IPC channels.
 *
 * Exposes intent-level functions so components never import ipc/client directly.
 */

import type { DirEntry } from "../../../shared/fs/types";
import { ipcOk } from "../../../shared/ipc/result";
import type { SshBrowseProgressEvent } from "../../../shared/types/workspace";
import type { IpcResult } from "../../ipc/client";
import { ipcCallResult, ipcListen } from "../../ipc/client";

// ---------------------------------------------------------------------------
// Open browse session
// ---------------------------------------------------------------------------

export interface OpenBrowseSessionArgs {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly authMode: "interactive" | "key-only";
  /**
   * Client-generated correlation id (uuid). When set, the main process streams
   * agent-bootstrap progress for this attempt via `ssh.browseProgress`; pair it
   * with subscribeSshBrowseProgress() to render a progress bar while connecting.
   */
  readonly progressId?: string;
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
    progressId: args.progressId,
  });
}

/**
 * Subscribe to SSH browse-session bootstrap progress events. Events are keyed
 * by the `progressId` the caller passed to openSshBrowseSession — the callback
 * receives every event so the caller filters by its own id. Returns a dispose
 * function; call it when the connect attempt ends.
 */
export function subscribeSshBrowseProgress(
  callback: (event: SshBrowseProgressEvent) => void,
): () => void {
  return ipcListen("ssh", "browseProgress", callback);
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
 * Returns the error envelope for callers that offer reconnect or retry.
 */
export async function browseSshSession(
  sessionId: string,
  path: string,
): Promise<IpcResult<BrowseSessionResult>> {
  const result = await ipcCallResult("ssh", "browseSession", { sessionId, path });
  if (!result.ok) return result;
  const dirs = result.value.entries
    .filter((e) => e.type === "dir" || e.type === "symlink")
    .sort((a, b) => a.name.localeCompare(b.name));
  return ipcOk({ entries: dirs, truncated: result.value.truncated });
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
    const result = await browseSshSession(sessionId, path);
    return result.ok ? result.value : null;
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
  // Fire-and-forget: close is best-effort cleanup; errors are silently ignored.
  await ipcCallResult("ssh", "closeBrowseSession", { sessionId }).catch(() => {});
}
