import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { closeChatTab } from "@/services/chat/claude/controller";
import { closeCodexTab } from "@/services/chat/codex/controller";
import { closeTerminalWithConfirm } from "@/services/terminal";
import { confirmCloseRunningPrograms, runningProgram } from "@/services/terminal/close-confirm";
import { closeGroup } from "@/state/operations/groups";
import { closeTab } from "@/state/operations/tabs";
import { flushStatePersistence } from "@/state/persistence";
import { useLayoutStore } from "@/state/stores/layout";
import { findLeaf } from "@/state/stores/layout/helpers";
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

const EDITOR_TYPES = new Set(["editor", "untitled", "editor.diff"]);

export async function closeGroupWithConfirm(
  workspaceId: string,
  groupId: string,
): Promise<CloseTabOutcome> {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const leaf = layout ? findLeaf(layout.root, groupId) : null;
  if (!leaf) return "closed";

  const tabIds = [...leaf.tabIds];
  const tabs = useTabsStore.getState().byWorkspace[workspaceId];
  const terminalIds = tabIds.filter((tabId) => {
    const tab = tabs?.[tabId];
    return tab?.type === "terminal" && !tab.props.dead;
  });
  const programs = (
    await Promise.all(terminalIds.map((tabId) => runningProgram(workspaceId, tabId)))
  ).filter((program) => program !== null);
  if (programs.length > 0 && !(await confirmCloseRunningPrograms(programs))) return "cancelled";

  for (const tabId of tabIds) {
    const type = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId]?.type;
    if (type === undefined || !EDITOR_TYPES.has(type)) continue;
    const outcome = await closeTabWithConfirm(workspaceId, tabId);
    if (outcome !== "closed") return outcome;
  }
  closeGroup(workspaceId, groupId);
  return "closed";
}
