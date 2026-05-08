import { registerWorkspaceCleanup } from "../../lifecycle/workspace-cleanup";
import { useLayoutStore } from "./store";

// Module-level workspace cleanup registration. Runs once when this module
// is first imported. The central registry (initialized from bootstrap)
// owns the IPC listener and dispatches to every registered handler.
registerWorkspaceCleanup((id) => {
  useLayoutStore.getState().closeAllForWorkspace(id);
});
