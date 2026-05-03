import { ipcListen } from "../../ipc/client";
import { useLayoutStore } from "./store";

// Module-level workspace:removed subscription.
// Registers once when this module is first imported.
// The `typeof window` guard keeps this importable from bun:test
// where `window.ipc` isn't installed.
const _unsubscribeWorkspaceRemoved =
  typeof window !== "undefined"
    ? ipcListen("workspace", "removed", ({ id }) => {
        useLayoutStore.getState().closeAllForWorkspace(id);
      })
    : undefined;

void _unsubscribeWorkspaceRemoved;
