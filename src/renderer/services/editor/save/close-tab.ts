import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { closeChatTab } from "@/services/chat/claude/controller";
import { chatTabIsWorking, confirmCloseRunningWork } from "@/services/chat/close-confirm";
import { closeCodexTab } from "@/services/chat/codex/controller";
import { closeTerminal, closeTerminalWithConfirm } from "@/services/terminal";
import { runningProgram } from "@/services/terminal/close-confirm";
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

export interface CloseTabOptions {
  askIfRunning?: boolean;
}

export async function closeTabWithConfirm(
  workspaceId: string,
  tabId: string,
  { askIfRunning = true }: CloseTabOptions = {},
): Promise<CloseTabOutcome> {
  const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
  if (!tab) return "closed";

  if (tab.type === "terminal") {
    if (askIfRunning) return closeTerminalWithConfirm(workspaceId, tabId);
    closeTerminal(tabId);
    return "closed";
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
    if (
      askIfRunning &&
      chatTabIsWorking(workspaceId, tabId) &&
      !(await confirmCloseRunningWork([], [tab.title]))
    ) {
      return "cancelled";
    }
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

const CLOSED_ONE_BY_ONE = new Set(["editor", "untitled", "editor.diff", "claude", "codex"]);
const EDITOR_TYPES = new Set(["editor", "untitled", "editor.diff"]);

function editorsFirst(workspaceId: string, tabIds: readonly string[]): string[] {
  const tabs = useTabsStore.getState().byWorkspace[workspaceId];
  const isEditor = (tabId: string) => EDITOR_TYPES.has(tabs?.[tabId]?.type ?? "");
  return [...tabIds.filter(isEditor), ...tabIds.filter((tabId) => !isEditor(tabId))];
}

async function confirmCloseRunningIn(
  workspaceId: string,
  tabIds: readonly string[],
): Promise<boolean> {
  const tabs = useTabsStore.getState().byWorkspace[workspaceId];
  const terminalIds = tabIds.filter((tabId) => {
    const tab = tabs?.[tabId];
    return tab?.type === "terminal" && !tab.props.dead;
  });
  const chats = tabIds.flatMap((tabId) => {
    const tab = tabs?.[tabId];
    if (tab?.type !== "claude" && tab?.type !== "codex") return [];
    return chatTabIsWorking(workspaceId, tabId) ? [tab.title] : [];
  });
  const running = await Promise.all(terminalIds.map((tabId) => runningProgram(workspaceId, tabId)));
  const programs = [...new Set(running.filter((program) => program !== null))];
  return confirmCloseRunningWork(programs, chats);
}

export async function closeTabsWithConfirm(
  workspaceId: string,
  tabIds: readonly string[],
): Promise<CloseTabOutcome> {
  if (!(await confirmCloseRunningIn(workspaceId, tabIds))) return "cancelled";
  for (const tabId of editorsFirst(workspaceId, tabIds)) {
    const outcome = await closeTabWithConfirm(workspaceId, tabId, { askIfRunning: false });
    if (outcome !== "closed") return outcome;
  }
  return "closed";
}

export async function closeGroupWithConfirm(
  workspaceId: string,
  groupId: string,
): Promise<CloseTabOutcome> {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId];
  const leaf = layout ? findLeaf(layout.root, groupId) : null;
  if (!leaf) return "closed";

  const tabIds = [...leaf.tabIds];
  if (!(await confirmCloseRunningIn(workspaceId, tabIds))) return "cancelled";

  for (const tabId of editorsFirst(workspaceId, tabIds)) {
    const type = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId]?.type;
    if (type === undefined || !CLOSED_ONE_BY_ONE.has(type)) continue;
    const outcome = await closeTabWithConfirm(workspaceId, tabId, { askIfRunning: false });
    if (outcome !== "closed") return outcome;
  }
  closeGroup(workspaceId, groupId);
  return "closed";
}
