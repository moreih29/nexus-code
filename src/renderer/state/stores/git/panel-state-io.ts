/**
 * Panel-state and view-option persistence helpers for the git store.
 *
 * Both calls are fire-and-forget: failures are logged but the local UI state
 * is never rolled back, so the user keeps the change they just made even
 * when the persistence write loses.
 */

import type { GitPanelStateUpdate } from "../../../../shared/git/types";
import { createLogger } from "../../../../shared/log/renderer";
import { canUseIpcBridge, ipcCallResult } from "../../../ipc/client";

const log = createLogger("git");

/**
 * Persist panel-state updates through the git channel. Skipped silently in
 * non-browser contexts (tests) where the IPC bridge isn't installed.
 */
export function persistPanelState(workspaceId: string, update: GitPanelStateUpdate): void {
  if (!canUseIpcBridge()) return;

  // Fire-and-forget: panel state is best-effort; UI is never rolled back on failure.
  void ipcCallResult("git", "setPanelState", { workspaceId, ...update }).then((result) => {
    if (!result.ok) log.error(`setPanelState failed: ${result.message}`);
  });
}
