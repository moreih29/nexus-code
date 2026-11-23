import { register } from "../../infra/ipc-router";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import { getViewOptionsHandler, setViewOptionsHandler } from "./state-handlers";

export function registerPanelChannel(storage: WorkspaceStorage): void {
  register("panel", {
    call: {
      getViewOptions: getViewOptionsHandler(storage),
      setViewOptions: setViewOptionsHandler(storage),
    },
    listen: {},
  });
}
