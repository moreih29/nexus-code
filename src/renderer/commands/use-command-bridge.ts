/**
 * Forwards `command.invoke` IPC events from the Application Menu into
 * the renderer's command registry. Mounted once at the app root so a
 * single subscription handles every menu click.
 */

import { useEffect } from "react";
import { ipcListen } from "../ipc/client";
import { executeCommand } from "./registry";

export function useCommandBridge(): void {
  useEffect(() => {
    return ipcListen("command", "invoke", ({ id }) => {
      // TEMPORARY: chord-debug. Remove with the chord debug logs.
      console.log("[chord] menu→IPC dispatch", { id });
      executeCommand(id);
    });
  }, []);
}
