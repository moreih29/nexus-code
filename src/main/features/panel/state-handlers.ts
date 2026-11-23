import { ipcContract } from "../../../shared/ipc/contract";
import type { PanelViewOptions } from "../../../shared/types/panel";
import { validateArgs } from "../../infra/ipc-router";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";

const c = ipcContract.panel.call;

export function getViewOptionsHandler(
  storage: WorkspaceStorage,
): (args: unknown) => PanelViewOptions {
  return (args: unknown): PanelViewOptions => {
    const { workspaceId, panelKind } = validateArgs(c.getViewOptions.args, args);
    return storage.getPanelViewOptions(workspaceId, panelKind);
  };
}

export function setViewOptionsHandler(storage: WorkspaceStorage): (args: unknown) => void {
  return (args: unknown): void => {
    const { workspaceId, panelKind, ...partial } = validateArgs(c.setViewOptions.args, args);
    storage.setPanelViewOptions(workspaceId, panelKind, partial);
  };
}
