import { useCallback, useEffect, useState } from "react";
import { showAgentList } from "@/services/agent-sessions/actions";
import { closeTabWithConfirm } from "@/services/editor/save/close-tab";
import { requestTabFocus } from "@/services/tab-focus";
import { openTerminal } from "@/services/terminal";
import {
  openClaudeTab,
  openCodexTab,
  openNewBrowserTab,
  openNewUntitledTab,
} from "@/state/operations/tabs";
import type { LayoutLeaf } from "@/state/stores/layout";
import { useLayoutStore } from "@/state/stores/layout";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { listenForPaneActivation } from "@/utils/pane-activation";
import type { ShellChoice } from "../../../../shared/pty/shell";
import { slotRegistry } from "../content/slot-registry";
import { DropIndicator } from "../dnd/drop-indicator";
import { useDropTarget } from "../dnd/use-drop-target";
import { GroupPlaceholder } from "./placeholder";
import { GroupTabBar } from "./tab-bar";

interface GroupViewProps {
  workspaceId: string;
  leaf: LayoutLeaf;
  onActivateGroup: (groupId: string) => void;
  isRootLeaf: boolean;
  workspaceRootPath: string;
}

const EMPTY_TABS: Record<string, Tab> = {};

export function GroupView({
  workspaceId,
  leaf,
  onActivateGroup,
  isRootLeaf,
  workspaceRootPath,
}: GroupViewProps) {
  const activeGroupId = useLayoutStore((s) => s.byWorkspace[workspaceId]?.activeGroupId ?? null);
  const tabsMap = useTabsStore((s) => s.byWorkspace[workspaceId] ?? EMPTY_TABS);

  const isActive = activeGroupId === leaf.id;
  const tabs = leaf.tabIds
    .map((id) => tabsMap[id])
    .filter((t): t is NonNullable<typeof t> => t !== undefined);

  function handleSelectTab(tabId: string) {
    const currentActiveTabId = leaf.activeTabId;
    useLayoutStore.getState().setActiveTabInGroup({
      workspaceId,
      groupId: leaf.id,
      tabId,
      activateGroup: true,
    });
    onActivateGroup(leaf.id);
    if (tabId === currentActiveTabId) {
      useTabsStore.getState().promoteFromPreview(workspaceId, tabId);
    }
  }

  const handleCloseTab = useCallback(
    (tabId: string) => {
      void closeTabWithConfirm(workspaceId, tabId);
    },
    [workspaceId],
  );

  function handleNewTerminalTab(shell?: ShellChoice) {
    openTerminal({ workspaceId, cwd: workspaceRootPath, shell }, { groupId: leaf.id });
    onActivateGroup(leaf.id);
  }

  function handleNewUntitledTab() {
    openNewUntitledTab(workspaceId);
    onActivateGroup(leaf.id);
  }

  function handleNewBrowserTab() {
    openNewBrowserTab(workspaceId);
    onActivateGroup(leaf.id);
  }

  function handleNewClaudeTab(profileId?: string) {
    const tab = openClaudeTab(
      workspaceId,
      { cwd: workspaceRootPath, ...(profileId ? { profileId } : {}) },
      { groupId: leaf.id },
    );
    requestTabFocus(tab.id);
    onActivateGroup(leaf.id);
  }

  function handleNewCodexTab(profileId?: string) {
    const tab = openCodexTab(
      workspaceId,
      { cwd: workspaceRootPath, ...(profileId ? { profileId } : {}) },
      { groupId: leaf.id },
    );
    requestTabFocus(tab.id);
    onActivateGroup(leaf.id);
  }

  function handleShowAgentList() {
    showAgentList(workspaceId);
  }

  function handleGroupClick() {
    if (!isActive) {
      useLayoutStore.getState().setActiveGroup(workspaceId, leaf.id);
      onActivateGroup(leaf.id);
    }
  }

  const showPlaceholder = isRootLeaf && leaf.tabIds.length === 0;

  const setSlotEl = useCallback(
    (el: HTMLElement | null) => {
      slotRegistry.set(workspaceId, leaf.id, el);
    },
    [workspaceId, leaf.id],
  );

  const { dropZone, attachRef, zoneRef } = useDropTarget({ workspaceId, groupId: leaf.id });

  const [outerEl, setOuterEl] = useState<HTMLElement | null>(null);
  const wrapperRef = useCallback(
    (el: HTMLElement | null) => {
      setOuterEl(el);
      attachRef(el);
    },
    [attachRef],
  );
  useEffect(() => {
    if (!outerEl) return;
    return listenForPaneActivation(outerEl, () => {
      const layout = useLayoutStore.getState().byWorkspace[workspaceId];
      if (!layout || layout.activeGroupId === leaf.id) return;
      useLayoutStore.getState().setActiveGroup(workspaceId, leaf.id);
      onActivateGroup(leaf.id);
    });
  }, [outerEl, workspaceId, leaf.id, onActivateGroup]);

  const slotRef = useCallback(
    (el: HTMLElement | null) => {
      setSlotEl(el);
      zoneRef(el);
    },
    [setSlotEl, zoneRef],
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click activates group; keyboard handled by focusable children
    // biome-ignore lint/a11y/noStaticElementInteractions: click activates group; keyboard handled by focusable children
    <div
      ref={wrapperRef}
      className="relative flex flex-col min-h-0 min-w-0 flex-1 island-surface rounded-(--radius-island) overflow-hidden"
      onClick={handleGroupClick}
    >
      <GroupTabBar
        workspaceId={workspaceId}
        leafId={leaf.id}
        tabIds={leaf.tabIds}
        tabs={tabs}
        activeTabId={leaf.activeTabId}
        workspaceRootPath={workspaceRootPath}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onNewTerminalTab={handleNewTerminalTab}
        onNewUntitledTab={handleNewUntitledTab}
        onNewBrowserTab={handleNewBrowserTab}
        onShowAgentList={handleShowAgentList}
        onNewClaudeTab={handleNewClaudeTab}
        onNewCodexTab={handleNewCodexTab}
        onActivateGroup={onActivateGroup}
      />

      <div ref={slotRef} data-group-slot={leaf.id} className="flex-1 min-h-0 min-w-0 relative">
        {showPlaceholder && <GroupPlaceholder />}
        {dropZone && <DropIndicator zone={dropZone} />}
      </div>

      {!isActive && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[var(--surface-island-inactive-veil)]"
        />
      )}
    </div>
  );
}
