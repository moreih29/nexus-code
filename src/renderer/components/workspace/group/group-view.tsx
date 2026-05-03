import { cn } from "@/utils/cn";
import type { LayoutLeaf } from "@/store/layout";
import { useLayoutStore } from "@/store/layout";
import { useTabsStore } from "@/store/tabs";
import { GroupContextMenu } from "./group-context-menu";
import { GroupPlaceholder } from "./group-placeholder";

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
  const activeGroupId = useLayoutStore((s) => s.byWorkspace[workspaceId]?.activeGroupId ?? null);
  const tabsMap = useTabsStore((s) => s.byWorkspace[workspaceId] ?? {});

  const layoutStore = useLayoutStore();
  const tabsStore = useTabsStore();

  const isActive = activeGroupId === leaf.id;
  const tabs = leaf.tabIds
    .map((id) => tabsMap[id])
    .filter((t): t is NonNullable<typeof t> => t !== undefined);

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
  // Render
  // ---------------------------------------------------------------------------

  const showPlaceholder = isRootLeaf && leaf.tabIds.length === 0;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click activates group; keyboard handled by focusable children
    <div
      className={cn("flex flex-col min-h-0 min-w-0 flex-1", isActive && "bg-frosted-veil")}
      onClick={handleGroupClick}
    >
      <GroupContextMenu
        workspaceId={workspaceId}
        leafId={leaf.id}
        tabIds={leaf.tabIds}
        tabs={tabs}
        activeTabId={leaf.activeTabId}
        workspaceRootPath={workspaceRootPath}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onNewTerminalTab={handleNewTerminalTab}
        onActivateGroup={onActivateGroup}
      />

      {/* Content slot — ContentPool uses querySelector('[data-group-slot="..."]') */}
      <div data-group-slot={leaf.id} className="flex-1 min-h-0 min-w-0 relative">
        {showPlaceholder && <GroupPlaceholder />}
      </div>
    </div>
  );
}
