import i18next from "i18next";
import { showConfirmDialog } from "@/components/ui/confirm-dialog";
import { ipcCallResult } from "@/ipc/client";
import { useTabsStore } from "@/state/stores/tabs";
import { isLoginShell } from "./controller";
import { closeTerminal } from "./open-terminal";

/** How long to wait for the agent's answer before closing without asking. */
const FOREGROUND_LOOKUP_TIMEOUT_MS = 1000;

/**
 * The program holding the terminal's foreground, or null when its shell does
 * (nothing is running) or the agent cannot tell in time.
 */
async function runningProgram(workspaceId: string, tabId: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), FOREGROUND_LOOKUP_TIMEOUT_MS);
  });
  const lookup = ipcCallResult("pty", "foregroundProcess", { workspaceId, tabId }).then(
    (result) => (result.ok ? result.value.name.trim() : ""),
    () => "",
  );
  const name = await Promise.race([lookup, timeout]);
  clearTimeout(timer);
  return name !== "" && !isLoginShell(name) ? name : null;
}

/**
 * Close a terminal tab, first asking when a program is still running in it
 * (VSCode's terminal.integrated.confirmOnKill): closing kills the session,
 * and with it whatever the user left running.
 */
export async function closeTerminalWithConfirm(
  workspaceId: string,
  tabId: string,
): Promise<"closed" | "cancelled"> {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (tab?.type === "terminal" && !tab.props.dead) {
    const program = await runningProgram(workspaceId, tabId);
    if (program !== null) {
      const ok = await showConfirmDialog({
        title: i18next.t("common:terminal.close_running_title"),
        description: i18next.t("common:terminal.close_running_description", { name: program }),
        confirmLabel: i18next.t("common:terminal.close_running_confirm"),
        variant: "destructive",
      });
      if (!ok) return "cancelled";
    }
  }
  closeTerminal(tabId);
  return "closed";
}
