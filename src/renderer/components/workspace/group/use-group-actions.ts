import {
  type CloseTabOutcome,
  closeEditor,
  closeEditorWithConfirm,
  filePathToModelUri,
  isDirty,
  openOrRevealEditor,
} from "@/services/editor";
import { closeTerminal, openTerminal } from "@/services/terminal";
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
  /**
   * Close one tab. For editor tabs the close goes through the dirty-aware
   * confirm flow (so bulk-close paths can't silently discard buffer edits).
   * Returns "no-tab" when the id is unknown or already gone.
   */
  async function closeTabForId(tabId: string): Promise<CloseTabOutcome | "no-tab"> {
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (!tab) return "no-tab";
    if (tab.type === "terminal") {
      closeTerminal(tabId);
      return "closed";
    }
    if (tab.type === "editor") {
      return await closeEditorWithConfirm(workspaceId, tabId);
    }
    return "no-tab";
  }

  /**
   * Close a list of tabs sequentially. Aborts on the first user-cancel
   * (matches VSCode bulk-close cancel semantics) and skips tabs whose
   * save fails so the user can react.
   */
  async function closeMany(tabIds: string[]): Promise<void> {
    for (const id of tabIds) {
      const outcome = await closeTabForId(id);
      if (outcome === "cancelled") return;
    }
  }

  // The bulk-close methods return Promise<void> because the underlying
  // confirm flow is async. Menu callers (Radix `onSelect`) discard the
  // promise; tests can `await` it to assert post-close state.
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

  // VSCode parity: "Close All Editors" closes pinned tabs too — pin only
  // protects against the *bulk* "Close Others / to the right" gestures.
  async function closeAll(): Promise<void> {
    await closeMany([...getTabIds()]);
  }

  /**
   * Close every editor tab in the group whose buffer is clean. No prompts,
   * no save calls — clean tabs by definition have no unsaved work. Pinned
   * tabs are closed too (a saved-clean pin is still saved-clean), matching
   * VSCode's "Close Saved" command.
   */
  function closeSaved() {
    const wsRecord = useTabsStore.getState().byWorkspace[workspaceId] ?? {};
    for (const id of getTabIds()) {
      const tab = wsRecord[id];
      if (tab?.type !== "editor") continue;
      if (isDirty(filePathToModelUri(tab.props.filePath))) continue;
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

    if (tab.type === "terminal") {
      openTerminal(
        { workspaceId, cwd: tab.props.cwd },
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
