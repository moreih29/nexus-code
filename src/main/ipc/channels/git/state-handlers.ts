/**
 * Panel-state handlers — thin wrappers around per-workspace persistence.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { GitPanelState } from "../../../../shared/types/git";
import type { WorkspaceStorage } from "../../../storage/workspace-storage";
import { validateArgs } from "../../router";

const c = ipcContract.git.call;

/**
 * Builds the getPanelState handler; WorkspaceStorage owns default fallback
 * behavior for fresh or partially populated workspace databases.
 */
export function getPanelStateHandler(storage: WorkspaceStorage): (args: unknown) => GitPanelState {
  return (args: unknown): GitPanelState => {
    const { workspaceId } = validateArgs(c.getPanelState.args, args);
    return storage.getGitPanelState(workspaceId);
  };
}

/**
 * Builds the setPanelState handler; partial updates let draft text and group
 * expansion state round-trip independently.
 */
export function setPanelStateHandler(storage: WorkspaceStorage): (args: unknown) => void {
  return (args: unknown): void => {
    const { workspaceId, ...state } = validateArgs(c.setPanelState.args, args);
    storage.setGitPanelState(workspaceId, state);
  };
}
