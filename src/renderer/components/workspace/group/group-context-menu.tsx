import { ContextMenu as RadixContextMenu } from "radix-ui";
import { useState } from "react";
import type { Tab } from "@/store/tabs";
import { TabBar } from "../tabs/tab-bar";
import { useGroupActions } from "./use-group-actions";

interface GroupContextMenuProps {
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

export function GroupContextMenu({
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
}: GroupContextMenuProps) {
  const [contextTabId, setContextTabId] = useState<string | null>(null);

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
            onSelect={() => { if (!contextTabId) return; actions.close(); }}
          >
            <span>Close</span>
          </RadixContextMenu.Item>

          <RadixContextMenu.Item
            className="flex items-center justify-between px-2 py-1 rounded-[3px] cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-frosted-veil-strong data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
            onSelect={() => { if (!contextTabId) return; actions.closeOthers(); }}
          >
            <span>Close Others</span>
          </RadixContextMenu.Item>

          <RadixContextMenu.Item
            className="flex items-center justify-between px-2 py-1 rounded-[3px] cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-frosted-veil-strong data-[disabled]:opacity-50 data-[disabled]:pointer-events-none"
            onSelect={() => { if (!contextTabId) return; actions.closeAllToRight(); }}
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
