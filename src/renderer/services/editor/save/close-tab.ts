import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { closeChatTab } from "@/services/chat/claude/controller";
import { closeCodexTab } from "@/services/chat/codex/controller";
import { closeTerminalWithConfirm } from "@/services/terminal";
import { closeTab } from "@/state/operations/tabs";
import { flushStatePersistence } from "@/state/persistence";
import { useTabsStore } from "@/state/stores/tabs";
import type { CloseTabOutcome } from "./close-handler";
import {
  closeDiffWithConfirm,
  closeEditorWithConfirm,
  closeUntitledWithConfirm,
} from "./close-handler";

export async function closeTabWithConfirm(
  workspaceId: string,
  tabId: string,
): Promise<CloseTabOutcome> {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!tab) return "closed";

  if (tab.type === "terminal") {
    return closeTerminalWithConfirm(workspaceId, tabId);
  }

  if (tab.type === "editor") {
    return closeEditorWithConfirm(workspaceId, tabId);
  }

  if (tab.type === "untitled") {
    return closeUntitledWithConfirm(workspaceId, tabId);
  }

  if (tab.type === "editor.diff") {
    return closeDiffWithConfirm(workspaceId, tabId);
  }

  if (tab.type === "git.commit" || tab.type === "browser" || tab.type === "note") {
    closeTab(workspaceId, tabId);
  }

  if (tab.type === "claude" || tab.type === "codex") {
    if (tab.props.instructions !== undefined && !(await flushStatePersistence())) {
      showToast({ kind: "error", message: i18next.t("settings:instructions.saveFailed") });
      return "cancelled";
    }
    if (tab.type === "claude") closeChatTab(workspaceId, tabId);
    else closeCodexTab(workspaceId, tabId);
    closeTab(workspaceId, tabId);
  }

  return "closed";
}
