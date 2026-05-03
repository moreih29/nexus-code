import { useLayoutStore } from "@/store/layout";
import { splitAndDuplicate } from "@/store/operations";
import { useTabsStore } from "@/store/tabs";

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
  const layoutStore = useLayoutStore();
  const tabsStore = useTabsStore();

  function close() {
    const tabId = getContextTabId();
    layoutStore.detachTab(workspaceId, tabId);
    tabsStore.removeTab(workspaceId, tabId);
  }

  function closeOthers() {
    const targetTabId = getContextTabId();
    const others = getTabIds().filter((id) => id !== targetTabId);
    for (const id of others) {
      layoutStore.detachTab(workspaceId, id);
      tabsStore.removeTab(workspaceId, id);
    }
  }

  function closeAllToRight() {
    const targetTabId = getContextTabId();
    const tabIds = getTabIds();
    const idx = tabIds.indexOf(targetTabId);
    if (idx === -1) return;
    const toClose = tabIds.slice(idx + 1);
    for (const id of toClose) {
      layoutStore.detachTab(workspaceId, id);
      tabsStore.removeTab(workspaceId, id);
    }
  }

  function splitRight() {
    const tabId = getContextTabId();
    if (!tabId) return;
    splitAndDuplicate(workspaceId, leafId, tabId, "horizontal", "after");
  }

  function splitDown() {
    const tabId = getContextTabId();
    if (!tabId) return;
    splitAndDuplicate(workspaceId, leafId, tabId, "vertical", "after");
  }

  function newTerminal() {
    const tab = tabsStore.createTab(workspaceId, "terminal", { cwd: workspaceRootPath });
    layoutStore.attachTab(workspaceId, leafId, tab.id);
    layoutStore.setActiveTabInGroup({
      workspaceId,
      groupId: leafId,
      tabId: tab.id,
      activateGroup: true,
    });
    onActivateGroup(leafId);
  }

  return { close, closeOthers, closeAllToRight, splitRight, splitDown, newTerminal };
}
