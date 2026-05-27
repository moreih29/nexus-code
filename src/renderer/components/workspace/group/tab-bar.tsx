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
import { useRef, useState } from "react";
import {
  ContextMenuContent,
  ContextMenuItems,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createPathActions } from "@/services/fs-mutations";
import { useTabEditingStore } from "@/state/stores/tab-editing";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
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
  onNewTerminalTab: () => void;
  onNewUntitledTab: () => void;
  onNewBrowserTab: () => void;
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
  onActivateGroup,
}: GroupTabBarProps) {
  const [contextTabId, setContextTabId] = useState<string | null>(null);

  // Focus handoff guard — Radix ContextMenu가 close 후 기본적으로 trigger로 focus를
  // 복귀시키는데, Rename Tab… 클릭으로 inline input이 막 mount된 직후 그 focus
  // 복귀가 input의 blur를 즉시 트리거해 commit→cancel→사라짐 깜빡임을 만든다.
  // file-tree inline-edit가 이미 동일 문제에 같은 패턴으로 해결되어 있다 —
  // 핸드오프가 발생할 때만 onCloseAutoFocus.preventDefault()로 Radix가 비켜서게 한다.
  const renameHandoffInFlight = useRef(false);

  const contextTab = contextTabId
    ? useTabsStore.getState().byWorkspace[workspaceId]?.[contextTabId]
    : null;
  const contextInfo: TabContextInfo | null = contextTab
    ? {
        isPinned: !!contextTab.isPinned,
        isEditor: contextTab.type === "editor",
        isTerminal: contextTab.type === "terminal",
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

  function renameTab() {
    if (!contextTabId) return;
    // Radix가 곧 close 시점에 trigger로 focus를 복귀시키는데, 그게 input의 blur로
    // 이어져 commit→cancel→사라짐을 유발. close 직전 flag를 세워 onCloseAutoFocus
    // 가드에서 prevent하도록 한다. 한 번 쓰고 reset.
    renameHandoffInFlight.current = true;
    useTabEditingStore.getState().startEditing(contextTabId);
  }

  const menuItems = buildGroupTabBarMenuItems({
    context: contextInfo,
    actions,
    togglePin,
    copyPath: pathActions.copyPath,
    copyRelativePath: pathActions.copyRelativePath,
    revealInFinder: pathActions.revealInFinder,
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
            onTabContextMenu={(tabId) => setContextTabId(tabId)}
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
