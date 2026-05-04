import { useCallback } from "react";
import { closeEditor } from "@/services/editor";
import { closeTerminal, openTerminal } from "@/services/terminal";
import type { LayoutLeaf } from "@/state/stores/layout";
import { useLayoutStore } from "@/state/stores/layout";
import { useTabsStore } from "@/state/stores/tabs";
import { cn } from "@/utils/cn";
import { slotRegistry } from "../content/slot-registry";
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
    const tab = tabsMap[tabId];
    if (tab?.type === "terminal") {
      closeTerminal(tabId);
      return;
    }
    if (tab?.type === "editor") {
      closeEditor(tabId);
    }
  }

  function handleNewTerminalTab() {
    openTerminal({ workspaceId, cwd: workspaceRootPath }, { groupId: leaf.id });
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

  const slotRef = useCallback(
    (el: HTMLElement | null) => {
      slotRegistry.set(workspaceId, leaf.id, el);
    },
    [workspaceId, leaf.id],
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click activates group; keyboard handled by focusable children
    // biome-ignore lint/a11y/noStaticElementInteractions: click activates group; keyboard handled by focusable children
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

      {/* Content slot — portal target registered in slotRegistry for ContentHost */}
      <div ref={slotRef} data-group-slot={leaf.id} className="flex-1 min-h-0 min-w-0 relative">
        {showPlaceholder && <GroupPlaceholder />}
      </div>
    </div>
  );
}
