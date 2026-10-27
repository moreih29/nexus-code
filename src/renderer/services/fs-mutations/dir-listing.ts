/**
 * Light-weight `readdir` wrapper that returns just the entry names as a Set.
 *
 * Used by copy/move flows to detect (or steer around) name collisions BEFORE
 * issuing the actual write. Pre-checking with readdir means a same-name
 * collision never makes the agent throw ALREADY_EXISTS — which would log
 * "Error occurred in handler for 'ipc:call'" on the main process even though
 * the renderer handles the collision gracefully.
 */

import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";

/**
 * List the entry names in a workspace-relative directory. Pass `""` for the
 * workspace root.
 */
export async function listDirNames(workspaceId: string, dirRelPath: string): Promise<Set<string>> {
  const entries = unwrapIpcResult(
    // includeHidden: a hidden entry (e.g. `.git`) still occupies its name, so
    // the plain explorer listing would let a copy/move collide with it.
    await ipcCallResult("fs", "readdir", { workspaceId, relPath: dirRelPath, includeHidden: true }),
  );
  return new Set(entries.map((e) => e.name));
}
