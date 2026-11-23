import { useCallback, useRef, useState } from "react";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createPathActions } from "@/services/fs-mutations";
import { toggleTabPin } from "@/state/operations";
import { useTabEditingStore } from "@/state/stores/tab-editing";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import type { ShellChoice } from "../../../../shared/pty/shell";
import { TabBar } from "../tabs/tab-bar";
import { buildGroupTabBarMenuItems, type TabContextInfo } from "./tab-bar-menu";
import { useGroupActions } from "./use-group-actions";

interface GroupTabBarProps {
  workspaceId: string;
  leafId: string;
  tabIds: string[];
  tabs: Tab[];
  activeTabId: string | null;
  workspaceRootPath: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTerminalTab: (shell?: ShellChoice) => void;
  onNewUntitledTab: () => void;
  onNewBrowserTab: () => void;
  onShowAgentList: () => void;
  onNewClaudeTab: (profileId?: string) => void;
  onNewCodexTab: (profileId?: string) => void;
  onActivateGroup: (groupId: string) => void;
}

export function GroupTabBar({
  workspaceId,
  leafId,
  tabIds,
  tabs,
  activeTabId,
  workspaceRootPath,
  onSelectTab,
  onCloseTab,
  onNewTerminalTab,
  onNewUntitledTab,
  onNewBrowserTab,
  onShowAgentList,
  onNewClaudeTab,
  onNewCodexTab,
  onActivateGroup,
}: GroupTabBarProps) {
  const [contextTabId, setContextTabId] = useState<string | null>(null);
  const handleTabContextMenu = useCallback((tabId: string) => setContextTabId(tabId), []);

  const renameHandoffInFlight = useRef(false);

  const contextTab = contextTabId
    ? useTabsStore.getState().byWorkspace[workspaceId]?.[contextTabId]
    : null;
  const contextInfo: TabContextInfo | null = contextTab
    ? {
        isPinned: !!contextTab.isPinned,
        isEditor: contextTab.type === "editor",
        canRename:
          contextTab.type === "terminal" ||
          contextTab.type === "claude" ||
          contextTab.type === "codex",
      }
    : null;

  const actions = useGroupActions({
    workspaceId,
    leafId,
    workspaceRootPath,
    getContextTabId: () => contextTabId ?? "",
    getTabIds: () => tabIds,
    onActivateGroup,
  });

  const pathActions = createPathActions({
    workspaceId,
    workspaceRootPath,
    getAbsPath: () =>
      contextTab && contextTab.type === "editor" ? contextTab.props.filePath : null,
  });

  function togglePin() {
    if (!contextTabId) return;
    toggleTabPin(workspaceId, contextTabId);
  }

  function renameTab() {
    if (!contextTabId) return;
    renameHandoffInFlight.current = true;
    useTabEditingStore.getState().startEditing(contextTabId);
  }

  const isRemote = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location.kind !== "local",
  );

  const menuItems = buildGroupTabBarMenuItems({
    context: contextInfo,
    actions,
    togglePin,
    copyPath: pathActions.copyPath,
    copyRelativePath: pathActions.copyRelativePath,
    revealInFinder: isRemote ? undefined : pathActions.revealInFinder,
    renameTab,
  });

  return (
    <ContextMenuRoot onOpenChange={(open) => !open && setContextTabId(null)}>
      <ContextMenuTrigger>
        <div>
          <TabBar
            workspaceId={workspaceId}
            leafId={leafId}
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onNewTerminalTab={onNewTerminalTab}
            onNewUntitledTab={onNewUntitledTab}
            onNewBrowserTab={onNewBrowserTab}
            onShowAgentList={onShowAgentList}
            onNewClaudeTab={onNewClaudeTab}
            onNewCodexTab={onNewCodexTab}
            onTabContextMenu={handleTabContextMenu}
          />
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (renameHandoffInFlight.current) {
            e.preventDefault();
            renameHandoffInFlight.current = false;
          }
        }}
      >
        <ContextMenuItems items={menuItems} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
