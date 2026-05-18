/**
 * Panel-state and view-option persistence helpers for the git store.
 *
 * Both calls are fire-and-forget: failures are logged but the local UI state
 * is never rolled back, so the user keeps the change they just made even
 * when the persistence write loses.
 */

import type { GitPanelStateUpdate } from "../../../shared/git/types";
import { canUseIpcBridge, ipcCall } from "../../ipc/client";

/**
 * Persist panel-state updates through the git channel. Skipped silently in
 * non-browser contexts (tests) where the IPC bridge isn't installed.
 */
export function persistPanelState(workspaceId: string, update: GitPanelStateUpdate): void {
  if (!canUseIpcBridge()) return;

  ipcCall("git", "setPanelState", { workspaceId, ...update }).catch((error: unknown) => {
    console.error("[git] setPanelState failed", error);
  });
}

