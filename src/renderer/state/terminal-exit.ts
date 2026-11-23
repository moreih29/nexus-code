import { ipcListen } from "../ipc/client";
import { forgetSession } from "../services/terminal/pty-client";
import { useTabsStore } from "./stores/tabs";

export function startTerminalExitListener(): () => void {
  return ipcListen("pty", "exit", ({ workspaceId, tabId }) => {
    forgetSession(workspaceId, tabId);
    useTabsStore.getState().setTerminalDead(workspaceId, tabId, true);
  });
}
