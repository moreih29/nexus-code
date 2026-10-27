// Renderer-wide handling of PTY exits reported by the main process.

import { ipcListen } from "../ipc/client";
import { forgetSession } from "../services/terminal/pty-client";
import { useTabsStore } from "./stores/tabs";

/**
 * Installs the app-wide `pty:exit` listener. Call once from bootstrap.
 * Returns the unlisten function to call on teardown.
 *
 * A TerminalView hears its PTY exit only while it is mounted. When an SSH
 * workspace's daemon is replaced, the "session expired" placeholder unmounts
 * every view of the workspace before main reports the expired sessions'
 * exits. Handling the exit here still marks the tab dead, so it offers Reopen
 * once the workspace reconnects instead of a blank terminal whose next spawn
 * is skipped as already live.
 */
export function startTerminalExitListener(): () => void {
  return ipcListen("pty", "exit", ({ workspaceId, tabId }) => {
    forgetSession(workspaceId, tabId);
    useTabsStore.getState().setTerminalDead(workspaceId, tabId, true);
  });
}
