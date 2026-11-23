import type { GitPanelStateUpdate } from "../../../../shared/git/types";
import { createLogger } from "../../../../shared/log/renderer";
import { canUseIpcBridge, ipcCallResult } from "../../../ipc/client";

const log = createLogger("git");

export function persistPanelState(workspaceId: string, update: GitPanelStateUpdate): void {
  if (!canUseIpcBridge()) return;

  void ipcCallResult("git", "setPanelState", { workspaceId, ...update }).then((result) => {
    if (!result.ok) log.error(`setPanelState failed: ${result.message}`);
  });
}
