import { registerWorkspaceCleanup } from "../../workspace-cleanup";
import { useLayoutStore } from "./store";

registerWorkspaceCleanup((id) => {
  useLayoutStore.getState().closeAllForWorkspace(id);
});
