import type { GitPanelState } from "../../../../shared/git/types";
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { WorkspaceStorage } from "../../../infra/storage/workspace-storage";

const c = ipcContract.git.call;

export function getPanelStateHandler(storage: WorkspaceStorage): (args: unknown) => GitPanelState {
  return (args: unknown): GitPanelState => {
    const { workspaceId } = validateArgs(c.getPanelState.args, args);
    return storage.getGitPanelState(workspaceId);
  };
}

export function setPanelStateHandler(storage: WorkspaceStorage): (args: unknown) => void {
  return (args: unknown): void => {
    const { workspaceId, ...state } = validateArgs(c.setPanelState.args, args);
    storage.setGitPanelState(workspaceId, state);
  };
}
