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
import type { EditorTabProps } from "@/services/editor";
import { revealInFinder as revealInFinderService } from "@/services/fs-mutations";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { copyText } from "@/utils/clipboard";
import { relPath } from "@/utils/path";
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

  function getEditorFilePath(): string | null {
    if (!contextTab || contextTab.type !== "editor") return null;
    return (contextTab.props as EditorTabProps).filePath;
  }

  function togglePin() {
    if (!contextTabId) return;
    useTabsStore.getState().togglePin(workspaceId, contextTabId);
  }

  function copyPath() {
    const filePath = getEditorFilePath();
    if (!filePath) return;
    copyText(filePath);
  }

  function copyRelativePath() {
    const filePath = getEditorFilePath();
    if (!filePath) return;
    copyText(relPath(filePath, workspaceRootPath));
  }

  function revealInFinder() {
    const filePath = getEditorFilePath();
    if (!filePath) return;
    void revealInFinderService({
      workspaceId,
      workspaceRootPath,
      absPath: filePath,
    });
  }

  const menuItems = buildGroupTabBarMenuItems({
    context: contextInfo,
    actions,
    togglePin,
    copyPath,
    copyRelativePath,
    revealInFinder,
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
