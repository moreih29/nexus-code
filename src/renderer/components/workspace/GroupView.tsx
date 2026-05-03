import { useRef } from "react";
import { ContextMenu as RadixContextMenu } from "radix-ui";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/store/layout";
import { useTabsStore } from "@/store/tabs";
import type { LayoutLeaf } from "@/store/layout";
import { TabBar } from "../TabBar";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GroupViewProps {
  workspaceId: string;
  leaf: LayoutLeaf;
  onActivateGroup: (groupId: string) => void;
  /**
   * True when this leaf is the root of the workspace layout (sole leaf).
   * Used to decide whether to render the empty-state placeholder.
   */
  isRootLeaf: boolean;
  /** Root path of the workspace for creating new terminal tabs. */
  workspaceRootPath: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GroupView({
  workspaceId,
  leaf,
  onActivateGroup,
  isRootLeaf,
  workspaceRootPath,
}: GroupViewProps) {
  const activeGroupId = useLayoutStore(
    (s) => s.byWorkspace[workspaceId]?.activeGroupId ?? null,
  );
  const tabsMap = useTabsStore((s) => s.byWorkspace[workspaceId] ?? {});

  const layoutStore = useLayoutStore();
  const tabsStore = useTabsStore();

  const isActive = activeGroupId === leaf.id;
  const tabs = leaf.tabIds
    .map((id) => tabsMap[id])
    .filter((t): t is NonNullable<typeof t> => t !== undefined);

  // Tracks which tabId was right-clicked so context menu items can act on it.
  const contextTabIdRef = useRef<string>("");

  // ---------------------------------------------------------------------------
  // Tab actions
  // ---------------------------------------------------------------------------

  function handleSelectTab(tabId: string) {
    layoutStore.setActiveTabInGroup({
      workspaceId,
      groupId: leaf.id,
      tabId,
      activateGroup: true,
    });
    onActivateGroup(leaf.id);
  }

  function handleCloseTab(tabId: string) {
    layoutStore.detachTab(workspaceId, tabId);
    tabsStore.removeTab(workspaceId, tabId);
  }

  function handleNewTerminalTab() {
    const tab = tabsStore.createTab(workspaceId, "terminal", {
      cwd: workspaceRootPath,
    });
    layoutStore.attachTab(workspaceId, leaf.id, tab.id);
    layoutStore.setActiveTabInGroup({
      workspaceId,
      groupId: leaf.id,
      tabId: tab.id,
      activateGroup: true,
    });
    onActivateGroup(leaf.id);
  }

  function handleGroupClick() {
    if (!isActive) {
      layoutStore.setActiveGroup(workspaceId, leaf.id);
      onActivateGroup(leaf.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Context menu actions
  // ---------------------------------------------------------------------------

  function handleContextClose() {
    handleCloseTab(contextTabIdRef.current);
  }

  function handleContextCloseOthers() {
    const targetTabId = contextTabIdRef.current;
    const others = leaf.tabIds.filter((id) => id !== targetTabId);
    for (const id of others) {
      layoutStore.detachTab(workspaceId, id);
      tabsStore.removeTab(workspaceId, id);
    }
  }

  function handleContextCloseAllToRight() {
    const targetTabId = contextTabIdRef.current;
    const idx = leaf.tabIds.indexOf(targetTabId);
    if (idx === -1) return;
    const toClose = leaf.tabIds.slice(idx + 1);
    for (const id of toClose) {
      layoutStore.detachTab(workspaceId, id);
      tabsStore.removeTab(workspaceId, id);
    }
  }

  function handleContextSplitRight() {
    const tabId = contextTabIdRef.current;
    if (!tabId) return;
    const newLeafId = layoutStore.splitGroup(
      workspaceId,
      leaf.id,
      "horizontal",
      "after",
    );
    layoutStore.detachTab(workspaceId, tabId);
    layoutStore.attachTab(workspaceId, newLeafId, tabId);
    layoutStore.setActiveTabInGroup({
      workspaceId,
      groupId: newLeafId,
      tabId,
      activateGroup: true,
    });
  }

  function handleContextSplitDown() {
    const tabId = contextTabIdRef.current;
    if (!tabId) return;
    const newLeafId = layoutStore.splitGroup(
      workspaceId,
      leaf.id,
      "vertical",
      "after",
    );
    layoutStore.detachTab(workspaceId, tabId);
    layoutStore.attachTab(workspaceId, newLeafId, tabId);
    layoutStore.setActiveTabInGroup({
      workspaceId,
      groupId: newLeafId,
      tabId,
      activateGroup: true,
    });
  }

  // Capture the tab ID from the right-click target by inspecting the DOM.
  // RadixTabs.Trigger renders a <button> with a `value` attribute equal to the
  // tab's id (matching the `value` prop passed to RadixTabs.Trigger).
  function handleContextMenuCapture(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    // Walk up to find the button that is a RadixTabs trigger (has a value attr).
    let el: HTMLElement | null = target;
    while (el) {
      const val = el.getAttribute("value") ?? el.getAttribute("data-value");
      if (val) {
        contextTabIdRef.current = val;
        return;
      }
      el = el.parentElement;
    }
    contextTabIdRef.current = "";
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const showPlaceholder = isRootLeaf && leaf.tabIds.length === 0;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click activates group; keyboard handled by focusable children
    <div
      className={cn(
        "flex flex-col min-h-0 min-w-0 flex-1",
        isActive && "bg-frosted-veil",
      )}
      onClick={handleGroupClick}
    >
      <RadixContextMenu.Root>
        <RadixContextMenu.Trigger asChild>
          <div onContextMenu={handleContextMenuCapture}>
            <TabBar
              tabs={tabs}
              activeTabId={leaf.activeTabId}
              onSelectTab={handleSelectTab}
              onCloseTab={handleCloseTab}
              onNewTerminalTab={handleNewTerminalTab}
            />
          </div>
        </RadixContextMenu.Trigger>

        <RadixContextMenu.Portal>
          <RadixContextMenu.Content className="bg-muted border border-mist-border rounded-[4px] text-app-ui-sm shadow-none px-1 py-1 z-50">
            <RadixContextMenu.Item
              className="px-2 py-1 rounded-[3px] cursor-default outline-none hover:bg-frosted-veil-strong"
              onSelect={handleContextClose}
            >
              Close
            </RadixContextMenu.Item>

            <RadixContextMenu.Item
              className="px-2 py-1 rounded-[3px] cursor-default outline-none hover:bg-frosted-veil-strong"
              onSelect={handleContextCloseOthers}
            >
              Close Others
            </RadixContextMenu.Item>

            <RadixContextMenu.Item
              className="px-2 py-1 rounded-[3px] cursor-default outline-none hover:bg-frosted-veil-strong"
              onSelect={handleContextCloseAllToRight}
            >
              Close All to the Right
            </RadixContextMenu.Item>

            <RadixContextMenu.Separator className="my-1 h-px bg-mist-border" />

            <RadixContextMenu.Item
              className="px-2 py-1 rounded-[3px] cursor-default outline-none hover:bg-frosted-veil-strong"
              onSelect={handleContextSplitRight}
            >
              Split Right
            </RadixContextMenu.Item>

            <RadixContextMenu.Item
              className="px-2 py-1 rounded-[3px] cursor-default outline-none hover:bg-frosted-veil-strong"
              onSelect={handleContextSplitDown}
            >
              Split Down
            </RadixContextMenu.Item>
          </RadixContextMenu.Content>
        </RadixContextMenu.Portal>
      </RadixContextMenu.Root>

      {/* Content slot — ContentPool uses querySelector('[data-group-slot="..."]') */}
      <div data-group-slot={leaf.id} className="flex-1 min-h-0 min-w-0 relative">
        {showPlaceholder && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 pointer-events-none select-none">
            <span className="text-app-ui-sm text-stone-gray">No tab open</span>
            <span className="text-app-ui-xs text-muted-foreground">
              Press Cmd+E to open a file
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
