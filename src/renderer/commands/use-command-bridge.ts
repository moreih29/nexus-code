import { useEffect } from "react";
import { ipcListen } from "../ipc/client";
import { executeCommand } from "./registry";

export function useCommandBridge(): void {
  useEffect(() => {
    return ipcListen("command", "invoke", ({ id }) => {
      executeCommand(id);
    });
  }, []);
}
