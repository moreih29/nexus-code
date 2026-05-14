/**
 * panel channel — registers panel view-options call handlers.
 */
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import { register } from "../../infra/ipc/router";
import { getViewOptionsHandler, setViewOptionsHandler } from "./state-handlers";

/**
 * Register the panel IPC channel's call handlers.
 * Exposes panel.getViewOptions and panel.setViewOptions to the renderer.
 */
export function registerPanelChannel(storage: WorkspaceStorage): void {
  register("panel", {
    call: {
      getViewOptions: getViewOptionsHandler(storage),
      setViewOptions: setViewOptionsHandler(storage),
    },
    listen: {},
  });
}
