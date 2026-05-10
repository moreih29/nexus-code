/**
 * panel channel — registers panel view-options call handlers.
 */
import type { WorkspaceStorage } from "../../../storage/workspace-storage";
import { register } from "../../router";
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
