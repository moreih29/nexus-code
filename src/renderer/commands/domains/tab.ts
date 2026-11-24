import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { cacheUriFor } from "../../services/editor/model/cache";
import { isDirty } from "../../services/editor/model/dirty-tracker";
import { closeTabsWithConfirm } from "../../services/editor/save/close-tab";
import { closeEditor } from "../../services/editor/tabs";
import { requestTabFocus } from "../../services/tab-focus";
import { toggleTabPin } from "../../state/operations";
import { useLayoutStore } from "../../state/stores/layout";
import { useTabsStore } from "../../state/stores/tabs";
import { closeTabById, getActiveTabContext } from "../context";
import { runPeerTabCommand } from "./peer-workspace";

function cycleActiveTab(delta: 1 | -1): void {
  const ctx = getActiveTabContext();
  if (!ctx) {
    runPeerTabCommand(delta === 1 ? "next" : "previous");
    return;
  }
  const { tabIds } = ctx.leaf;
  if (tabIds.length < 2) return;

  const currentIndex = tabIds.indexOf(ctx.tabId);
  const nextIndex =
    currentIndex < 0
      ? delta === 1
        ? 0
        : tabIds.length - 1
      : (currentIndex + delta + tabIds.length) % tabIds.length;

  const tabId = tabIds[nextIndex];
  useLayoutStore.getState().setActiveTabInGroup({
    workspaceId: ctx.wsId,
    groupId: ctx.leaf.id,
    tabId,
    activateGroup: true,
  });
  requestTabFocus(tabId);
}

export function registerTabCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.tabClose, () => {
      const ctx = getActiveTabContext();
      if (!ctx) {
        runPeerTabCommand("close");
        return;
      }
      void closeTabById(ctx.wsId, ctx.tabId);
    }),

    registerCommand(COMMANDS.tabCloseOthers, async () => {
      const ctx = getActiveTabContext();
      if (!ctx) {
        runPeerTabCommand("closeOthers");
        return;
      }
      const wsRecord = useTabsStore.getState().byWorkspace[ctx.wsId] ?? {};
      const others = ctx.leaf.tabIds.filter((id) => id !== ctx.tabId && !wsRecord[id]?.isPinned);
      await closeTabsWithConfirm(ctx.wsId, others);
    }),

    registerCommand(COMMANDS.tabCloseSaved, () => {
      const ctx = getActiveTabContext();
      if (!ctx) return;
      const wsRecord = useTabsStore.getState().byWorkspace[ctx.wsId] ?? {};
      for (const id of ctx.leaf.tabIds) {
        const tab = wsRecord[id];
        if (tab?.type !== "editor") continue;
        if (isDirty(cacheUriFor(tab.props.workspaceId, tab.props.filePath))) continue;
        closeEditor(id);
      }
    }),

    registerCommand(COMMANDS.tabCloseAll, async () => {
      const ctx = getActiveTabContext();
      if (!ctx) {
        runPeerTabCommand("closeAll");
        return;
      }
      await closeTabsWithConfirm(ctx.wsId, [...ctx.leaf.tabIds]);
    }),

    registerCommand(COMMANDS.tabPinToggle, () => {
      const ctx = getActiveTabContext();
      if (!ctx) return;
      toggleTabPin(ctx.wsId, ctx.tabId);
    }),

    registerCommand(COMMANDS.tabFocusPrev, () => cycleActiveTab(-1)),
    registerCommand(COMMANDS.tabFocusNext, () => cycleActiveTab(1)),
  ];
}
