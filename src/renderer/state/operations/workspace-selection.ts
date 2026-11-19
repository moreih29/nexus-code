import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import { useActiveStore } from "../stores/active";
import { useAgentViewStore } from "../stores/agent-view";

const log = createLogger("tasks");

/** Activates a workspace here and tells main, which connects an SSH one. */
export function activateWorkspace(id: string): void {
  // Asked to show a workspace, the window shows the workspaces.
  useAgentViewStore.getState().setMode("workspace");
  useActiveStore.getState().setActiveWorkspaceId(id);
  void ipcCallResult("workspace", "activate", { id }).then((result) => {
    if (!result.ok) log.warn(`workspace activate failed: ${result.message}`);
  });
}
