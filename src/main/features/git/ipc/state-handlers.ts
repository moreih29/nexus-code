/**
 * Panel-state handlers — thin wrappers around per-workspace persistence.
 */

import type { GitPanelState } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { WorkspaceStorage } from "../../../infra/storage/workspace-storage";

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
