/**
 * Debounced setViewOptions IPC persister for the shared panel-view-options store.
 *
 * A per-(panelKind × workspaceId) timer map collapses rapid successive writes
 * (e.g. quickly toggling compact on/off) into a single IPC call per settle
 * period. The cancel helper is called when the workspace is closed so no
 * stale write fires after the session is gone.
 */

import type { PanelKind } from "../../../../shared/types/panel";
import type { ViewMode } from "../../../../shared/types/panel";
import { STATE_PERSIST_DEBOUNCE_MS } from "../../../../shared/util/timing-constants";
import { canUseIpcBridge, ipcCallResult } from "../../../ipc/client";

/** Module-private debounce timers keyed by `panelKind:workspaceId`. */
const viewOptionsSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(panelKind: PanelKind, workspaceId: string): string {
  return `${panelKind}:${workspaceId}`;
}

/**
 * Schedule a debounced persist of viewMode + compactFolders for a
 * (panelKind, workspaceId) pair. Repeated calls within
 * STATE_PERSIST_DEBOUNCE_MS reset the timer so only the final value reaches
 * storage.
 */
export function scheduleViewOptionsSave(
  panelKind: PanelKind,
  workspaceId: string,
  viewMode: ViewMode,
  compactFolders: boolean,
): void {
  if (!canUseIpcBridge()) return;

  const key = timerKey(panelKind, workspaceId);
  const existing = viewOptionsSaveTimers.get(key);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(() => {
    viewOptionsSaveTimers.delete(key);
    // Fire-and-forget: view-option persistence is best-effort; local state is never rolled back.
    void ipcCallResult("panel", "setViewOptions", {
      workspaceId,
      panelKind,
      viewMode,
      compactFolders,
    }).then((result) => {
      if (!result.ok)
        console.error(`[panel-view-options] setViewOptions failed for ${panelKind}`, result.message);
    });
  }, STATE_PERSIST_DEBOUNCE_MS);

  viewOptionsSaveTimers.set(key, handle);
}

/**
 * Cancel all pending view-option saves for a workspace (across all panel
 * kinds). Called when a workspace is closed so no stale timer fires after the
 * session is removed.
 */
export function cancelViewOptionsSave(workspaceId: string): void {
  for (const panelKind of ["git", "search"] as PanelKind[]) {
    const key = timerKey(panelKind, workspaceId);
    const existing = viewOptionsSaveTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      viewOptionsSaveTimers.delete(key);
    }
  }
}
