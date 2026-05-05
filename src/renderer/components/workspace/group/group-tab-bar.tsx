/**
 * GroupTabBar — the tab strip for a layout leaf, plus its right-click
 * context menu (Close / Close Others / Close All to the Right / Split
 * Right / Split Down).
 *
 * Earlier name was `GroupContextMenu` but the component's primary
 * responsibility is rendering the tab bar; the ContextMenu is a layer
 * around it. The name is now organised around the visible deliverable
 * (the tab bar in a group), with the menu as a co-located concern.
 *
 * The dumb `TabBar` lives in `tabs/` and is reused; this wrapper adds
 * the group-policy concerns (which actions to expose, which tab the
 * menu is currently anchored to).
 */
import { ContextMenu as RadixContextMenu } from "radix-ui";
import { useState } from "react";
import { useTabsStore, type Tab } from "@/state/stores/tabs";
import { TabBar } from "../tabs/tab-bar";
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

  const actions = useGroupActions({
    workspaceId,
    leafId,
    workspaceRootPath,
    getContextTabId: () => contextTabId ?? "",
    getTabIds: () => tabIds,
    onActivateGroup,
  });

  return (
    <RadixContextMenu.Root onOpenChange={(open) => !open && setContextTabId(null)}>
      <RadixContextMenu.Trigger asChild>
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
      </RadixContextMenu.Trigger>

      <RadixContextMenu.Portal>
        <RadixContextMenu.Content className="bg-popover text-popover-foreground border border-mist-border rounded-[4px] shadow-sm py-1 min-w-[180px] z-50">
          <RadixContextMenu.Item
            className="flex items-center justify-between px-2 py-1 rounded-[3px] cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-frosted-veil-strong data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
            onSelect={() => {
              if (!contextTabId) return;
              useTabsStore.getState().togglePin(workspaceId, contextTabId);
            }}
          >
            <span>{contextTab?.isPinned ? "Unpin Tab" : "Pin Tab"}</span>
          </RadixContextMenu.Item>

          <RadixContextMenu.Separator className="h-px bg-mist-border my-1" />

          <RadixContextMenu.Item
            className="flex items-center justify-between px-2 py-1 rounded-[3px] cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-frosted-veil-strong data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
            onSelect={() => {
              if (!contextTabId) return;
              actions.close();
            }}
          >
            <span>Close</span>
          </RadixContextMenu.Item>

          <RadixContextMenu.Item
            className="flex items-center justify-between px-2 py-1 rounded-[3px] cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-frosted-veil-strong data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
            onSelect={() => {
              if (!contextTabId) return;
              actions.closeOthers();
            }}
          >
            <span>Close Others</span>
          </RadixContextMenu.Item>

          <RadixContextMenu.Item
            className="flex items-center justify-between px-2 py-1 rounded-[3px] cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-frosted-veil-strong data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
            onSelect={() => {
              if (!contextTabId) return;
              actions.closeAllToRight();
            }}
          >
            <span>Close All to the Right</span>
          </RadixContextMenu.Item>

          <RadixContextMenu.Separator className="h-px bg-mist-border my-1" />

          <RadixContextMenu.Item
            className="flex items-center justify-between px-2 py-1 rounded-[3px] cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-frosted-veil-strong data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
            onSelect={actions.splitRight}
          >
            <span>Split Right</span>
            <span className="text-muted-foreground ml-4 font-mono">⌘\</span>
          </RadixContextMenu.Item>

          <RadixContextMenu.Item
            className="flex items-center justify-between px-2 py-1 rounded-[3px] cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-frosted-veil-strong data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
            onSelect={actions.splitDown}
          >
            <span>Split Down</span>
            <span className="text-muted-foreground ml-4 font-mono">⌘⇧\</span>
          </RadixContextMenu.Item>
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
