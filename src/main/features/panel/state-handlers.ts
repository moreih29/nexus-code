/**
 * Panel view-options handlers — thin wrappers around per-workspace persistence.
 */
import { ipcContract } from "../../../shared/ipc/ipc-contract";
import type { PanelViewOptions } from "../../../shared/types/panel";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import { validateArgs } from "../../infra/ipc/router";

const c = ipcContract.panel.call;

/**
 * Builds the getViewOptions handler. WorkspaceStorage returns the
 * DEFAULT_VIEW_OPTIONS_BY_PANEL fallback when no row exists for the panel kind.
 */
export function getViewOptionsHandler(
  storage: WorkspaceStorage,
): (args: unknown) => PanelViewOptions {
  return (args: unknown): PanelViewOptions => {
    const { workspaceId, panelKind } = validateArgs(c.getViewOptions.args, args);
    return storage.getPanelViewOptions(workspaceId, panelKind);
  };
}

/**
 * Builds the setViewOptions handler. Partial updates let viewMode and
 * compactFolders round-trip independently.
 */
export function setViewOptionsHandler(storage: WorkspaceStorage): (args: unknown) => void {
  return (args: unknown): void => {
    const { workspaceId, panelKind, ...partial } = validateArgs(c.setViewOptions.args, args);
    storage.setPanelViewOptions(workspaceId, panelKind, partial);
  };
}
