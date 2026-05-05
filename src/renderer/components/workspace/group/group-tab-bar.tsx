/**
 * GroupTabBar — the tab strip for a layout leaf, plus its right-click
 * context menu (Pin / Close family / Split / Copy Path family for editor
 * tabs).
 *
 * The dumb `TabBar` lives in `tabs/` and is reused; this wrapper adds
 * the group-policy concerns: which actions to expose, which tab the
 * menu is currently anchored to. The menu *contents* live in
 * `group-tab-bar-menu.ts` as a pure builder so the branching logic can
 * be unit-tested without mounting React.
 */
import { useState } from "react";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createPathActions } from "@/services/fs-mutations";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { TabBar } from "../tabs/tab-bar";
import { buildGroupTabBarMenuItems, type TabContextInfo } from "./group-tab-bar-menu";
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
  onNewTerminalTab: () => void;
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
  onActivateGroup,
}: GroupTabBarProps) {
  const [contextTabId, setContextTabId] = useState<string | null>(null);

  const contextTab = contextTabId
    ? useTabsStore.getState().byWorkspace[workspaceId]?.[contextTabId]
    : null;
  const contextInfo: TabContextInfo | null = contextTab
    ? { isPinned: !!contextTab.isPinned, isEditor: contextTab.type === "editor" }
    : null;

  const actions = useGroupActions({
    workspaceId,
    leafId,
    workspaceRootPath,
    getContextTabId: () => contextTabId ?? "",
    getTabIds: () => tabIds,
    onActivateGroup,
  });

  // Anchor the path actions to whichever tab the menu currently points at.
  // The resolver returns null for non-editor tabs (terminals, etc.) so the
  // shared `createPathActions` no-ops cleanly without each menu callsite
  // re-checking tab type.
  const pathActions = createPathActions({
    workspaceId,
    workspaceRootPath,
    getAbsPath: () =>
      contextTab && contextTab.type === "editor" ? contextTab.props.filePath : null,
  });

  function togglePin() {
    if (!contextTabId) return;
    useTabsStore.getState().togglePin(workspaceId, contextTabId);
  }

  const menuItems = buildGroupTabBarMenuItems({
    context: contextInfo,
    actions,
    togglePin,
    copyPath: pathActions.copyPath,
    copyRelativePath: pathActions.copyRelativePath,
    revealInFinder: pathActions.revealInFinder,
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
            onTabContextMenu={(tabId) => setContextTabId(tabId)}
          />
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItems items={menuItems} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
