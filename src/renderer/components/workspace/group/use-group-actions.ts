import { closeEditor, openOrRevealEditor, type EditorTabProps } from "@/services/editor";
import { closeTerminal, openTerminal } from "@/services/terminal";
import { type TerminalTabProps, useTabsStore } from "@/state/stores/tabs";

interface UseGroupActionsOptions {
  workspaceId: string;
  leafId: string;
  workspaceRootPath: string;
  getContextTabId: () => string;
  getTabIds: () => string[];
  onActivateGroup: (groupId: string) => void;
}

export function useGroupActions({
  workspaceId,
  leafId,
  workspaceRootPath,
  getContextTabId,
  getTabIds,
  onActivateGroup,
}: UseGroupActionsOptions) {
  function closeTabForId(tabId: string) {
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (tab?.type === "terminal") {
      closeTerminal(tabId);
      return;
    }
    if (tab?.type === "editor") {
      closeEditor(tabId);
    }
  }

  function close() {
    const tabId = getContextTabId();
    closeTabForId(tabId);
  }

  function closeOthers() {
    const targetTabId = getContextTabId();
    const wsRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
    const others = getTabIds().filter((id) => {
      if (id === targetTabId) return false;
      return !wsRecord[id]?.isPinned;
    });
    for (const id of others) {
      closeTabForId(id);
    }
  }

  function closeAllToRight() {
    const targetTabId = getContextTabId();
    const tabIds = getTabIds();
    const idx = tabIds.indexOf(targetTabId);
    if (idx === -1) return;
    const wsRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
    const toClose = tabIds.slice(idx + 1).filter((id) => !wsRecord[id]?.isPinned);
    for (const id of toClose) {
      closeTabForId(id);
    }
  }

  function splitContextTab(orientation: "horizontal" | "vertical") {
    const tabId = getContextTabId();
    if (!tabId) return;
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (!tab) return;

    if (tab.type === "editor") {
      onActivateGroup(leafId);
      openOrRevealEditor(tab.props as EditorTabProps, {
        newSplit: { orientation, side: "after" },
      });
      return;
    }

    if (tab.type === "terminal") {
      const props = tab.props as TerminalTabProps;
      openTerminal(
        { workspaceId, cwd: props.cwd },
        { groupId: leafId, newSplit: { orientation, side: "after" } },
      );
    }
  }

  function splitRight() {
    splitContextTab("horizontal");
  }

  function splitDown() {
    splitContextTab("vertical");
  }

  function newTerminal() {
    openTerminal({ workspaceId, cwd: workspaceRootPath }, { groupId: leafId });
    onActivateGroup(leafId);
  }

  return { close, closeOthers, closeAllToRight, splitRight, splitDown, newTerminal };
}
