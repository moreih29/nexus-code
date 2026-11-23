import { createLogger } from "../../../../shared/log/renderer";
import type { PanelKind, ViewMode } from "../../../../shared/types/panel";
import { createKeyedDebouncer } from "../../../../shared/util/keyed-debouncer";
import { STATE_PERSIST_DEBOUNCE_MS } from "../../../../shared/util/timing-constants";
import { canUseIpcBridge, ipcCallResult } from "../../../ipc/client";

const log = createLogger("panel-view-options");

const viewOptionsSaves = createKeyedDebouncer<string>({ delayMs: STATE_PERSIST_DEBOUNCE_MS });

function timerKey(panelKind: PanelKind, workspaceId: string): string {
  return `${panelKind}:${workspaceId}`;
}

export function scheduleViewOptionsSave(
  panelKind: PanelKind,
  workspaceId: string,
  viewMode: ViewMode,
): void {
  if (!canUseIpcBridge()) return;

  viewOptionsSaves.schedule(timerKey(panelKind, workspaceId), () => {
    void ipcCallResult("panel", "setViewOptions", {
      workspaceId,
      panelKind,
      viewMode,
    }).then((result) => {
      if (!result.ok) log.error(`setViewOptions failed for ${panelKind}: ${result.message}`);
    });
  });
}

export function cancelViewOptionsSave(workspaceId: string): void {
  for (const panelKind of ["git", "search"] as PanelKind[]) {
    viewOptionsSaves.cancel(timerKey(panelKind, workspaceId));
  }
}
