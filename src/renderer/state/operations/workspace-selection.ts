import { createLogger } from "../../../shared/log/renderer";
import { ipcCallResult } from "../../ipc/client";
import { useActiveStore } from "../stores/active";
import { useAgentViewStore } from "../stores/agent-view";
import { type PeerWorkspaceTarget, usePeerWorkspaceStore } from "../stores/peer-workspace";
import { useWorkspacesStore, visibleWorkspaces } from "../stores/workspaces";

const log = createLogger("workspace-selection");

type WorkspaceView = "workspace" | "preserve";

/** Show a workspace in this window for a reveal or a restored selection. */
export function focusWorkspace(id: string | null, view: WorkspaceView): void {
  if (view === "workspace") useAgentViewStore.getState().setMode("workspace");
  useActiveStore.getState().setActiveWorkspaceId(id);
  usePeerWorkspaceStore.getState().clearSelection();
}

/** Apply the user's workspace selection and send it to main for persistence and connection. */
export function activateWorkspace(id: string, view: WorkspaceView = "workspace"): void {
  focusWorkspace(id, view);
  void ipcCallResult("workspace", "activate", { id })
    .then((result) => {
      if (!result.ok && result.kind !== "cancelled") {
        log.warn(`Workspace activation failed: ${result.message}`);
      }
    })
    .catch((error: unknown) => log.warn(`Workspace activation failed: ${String(error)}`));
}

/** Select a peer in this window. Main keeps its last local selection. */
export function selectPeerWorkspace(target: PeerWorkspaceTarget): void {
  const local = useActiveStore.getState();
  local.setActiveWorkspaceId(null);
  usePeerWorkspaceStore.getState().select(target, local.activeWorkspaceId);
  useAgentViewStore.getState().setMode("workspace");
}

export function returnFromPeerWorkspace(): void {
  const { active, lastLocalId } = usePeerWorkspaceStore.getState();
  if (!active) return;
  const { workspaces } = useWorkspacesStore.getState();
  const next = workspaces.some(({ id }) => id === lastLocalId)
    ? lastLocalId
    : (visibleWorkspaces(workspaces)[0]?.id ?? null);
  focusWorkspace(next, "preserve");
}

/** Connect the workspace being shown, independently of the selection. */
export function connectWorkspace(id: string, signal?: AbortSignal) {
  return ipcCallResult("workspace", "connect", { id }, { signal });
}

/** Retry from a panel that already displays connection status. */
export function retryWorkspaceConnection(id: string): void {
  void connectWorkspace(id)
    .then((result) => {
      if (!result.ok && result.kind !== "cancelled") {
        log.warn(`Workspace connection failed: ${result.message}`);
      }
    })
    .catch((error: unknown) => log.warn(`Workspace connection failed: ${String(error)}`));
}
