import i18next from "i18next";
import { showConfirmDialog } from "@/components/ui/confirm-dialog";
import { confirmCloseRunningPrograms } from "@/services/terminal/close-confirm";
import { type ChatTabState, chatKey, useChatStore } from "./store";

const PROGRAM_GONE = new Set<ChatTabState["phase"]>(["ended", "failed", "not-found"]);

export function chatIsWorking(state: ChatTabState | undefined): boolean {
  if (!state || PROGRAM_GONE.has(state.phase)) return false;
  const { model, queue } = state;
  return (
    model.running ||
    model.streaming !== null ||
    model.permissions.length > 0 ||
    Object.values(model.tasks).some((task) => task.status === "running") ||
    queue.some((item) => item.status === "sending")
  );
}

export function chatTabIsWorking(workspaceId: string, tabId: string): boolean {
  return chatIsWorking(useChatStore.getState().tabs[chatKey(workspaceId, tabId)]);
}

export function confirmCloseRunningWork(
  programs: readonly string[],
  chats: readonly string[],
): Promise<boolean> {
  if (chats.length === 0) {
    return programs.length === 0 ? Promise.resolve(true) : confirmCloseRunningPrograms(programs);
  }
  if (programs.length > 0) {
    return showConfirmDialog({
      title: i18next.t("common:chat.close_running_mixed_title"),
      description: i18next.t("common:chat.close_running_mixed_description", {
        name: programs.join(", "),
        count: chats.length,
      }),
      confirmLabel: i18next.t("common:chat.close_working_confirm"),
      variant: "destructive",
    });
  }
  return showConfirmDialog({
    title: i18next.t("common:chat.close_working_title"),
    description:
      chats.length === 1
        ? i18next.t("common:chat.close_working_description", { name: chats[0] })
        : i18next.t("common:chat.close_working_several_description", { count: chats.length }),
    confirmLabel: i18next.t("common:chat.close_working_confirm"),
    variant: "destructive",
  });
}
