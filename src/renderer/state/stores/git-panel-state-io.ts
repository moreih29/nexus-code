/**
 * Panel-state and view-option persistence helpers for the git store.
 *
 * Both calls are fire-and-forget: failures are logged but the local UI state
 * is never rolled back, so the user keeps the change they just made even
 * when the persistence write loses.
 */

import type { GitPanelStateUpdate } from "../../../shared/git/types";
import type { ViewMode } from "../../../shared/types/panel";
import { ipcCall } from "../../ipc/client";
import { canUseIpcBridge } from "./git-store-helpers";

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

/**
 * Persist panel view-options through the panel channel. Skipped silently in
 * non-browser contexts (tests) where the IPC bridge isn't installed.
 */
export function persistViewOptions(
  workspaceId: string,
  partial: { viewMode?: ViewMode; compactFolders?: boolean },
): void {
  if (!canUseIpcBridge()) return;

  ipcCall("panel", "setViewOptions", { workspaceId, panelKind: "git", ...partial }).catch(
    (error: unknown) => {
      console.error("[git] setViewOptions failed", error);
    },
  );
}
