import { cacheUriFor } from "@/services/editor/model/cache";
import { isDirty } from "@/services/editor/model/dirty-tracker";
import type { CloseTabOutcome } from "@/services/editor/save/close-handler";
import { closeTabsWithConfirm, closeTabWithConfirm } from "@/services/editor/save/close-tab";
import { closeEditor, openOrRevealEditor } from "@/services/editor/tabs";
import { openTerminal } from "@/services/terminal";
import { openTabInNewSplit } from "@/state/operations/tabs";
import { useTabsStore } from "@/state/stores/tabs";

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
  async function closeTabForId(tabId: string): Promise<CloseTabOutcome> {
    return closeTabWithConfirm(workspaceId, tabId);
  }

  async function closeMany(tabIds: string[]): Promise<void> {
    await closeTabsWithConfirm(workspaceId, tabIds);
  }

  async function close(): Promise<void> {
    await closeTabForId(getContextTabId());
  }

  async function closeOthers(): Promise<void> {
    const targetTabId = getContextTabId();
    const wsRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
    const others = getTabIds().filter((id) => {
      if (id === targetTabId) return false;
      return !wsRecord[id]?.isPinned;
    });
    await closeMany(others);
  }

  async function closeAllToRight(): Promise<void> {
    const targetTabId = getContextTabId();
    const tabIds = getTabIds();
    const idx = tabIds.indexOf(targetTabId);
    if (idx === -1) return;
    const wsRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
    const toClose = tabIds.slice(idx + 1).filter((id) => !wsRecord[id]?.isPinned);
    await closeMany(toClose);
  }

  async function closeAll(): Promise<void> {
    await closeMany([...getTabIds()]);
  }

  function closeSaved() {
    const wsRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
    for (const id of getTabIds()) {
      const tab = wsRecord[id];
      if (tab?.type !== "editor") continue;
      if (isDirty(cacheUriFor(tab.props.workspaceId, tab.props.filePath))) continue;
      closeEditor(id);
    }
  }

  function splitContextTab(orientation: "horizontal" | "vertical") {
    const tabId = getContextTabId();
    if (!tabId) return;
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (!tab) return;

    if (tab.type === "editor") {
      onActivateGroup(leafId);
      openOrRevealEditor(tab.props, {
        newSplit: { orientation, side: "after" },
      });
      return;
    }

    if (tab.type === "editor.diff") {
      onActivateGroup(leafId);
      openTabInNewSplit(
        workspaceId,
        { type: "editor.diff", props: tab.props },
        orientation,
        "after",
      );
      return;
    }

    if (tab.type === "terminal") {
      openTerminal(
        {
          workspaceId,
          cwd: tab.props.cwd,
          shell: tab.props.shell,
          ...(tab.props.profile !== undefined ? { profile: tab.props.profile } : {}),
        },
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

  return {
    close,
    closeOthers,
    closeAllToRight,
    closeAll,
    closeSaved,
    splitRight,
    splitDown,
    newTerminal,
  };
}
