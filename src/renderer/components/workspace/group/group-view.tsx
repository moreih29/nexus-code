import { useCallback } from "react";
import { closeEditor } from "@/services/editor";
import { closeTerminal, openTerminal } from "@/services/terminal";
import type { LayoutLeaf } from "@/state/stores/layout";
import { useLayoutStore } from "@/state/stores/layout";
import { useTabsStore } from "@/state/stores/tabs";
import { cn } from "@/utils/cn";
import { slotRegistry } from "../content/slot-registry";
import { DropIndicator } from "../dnd/drop-indicator";
import { useDropTarget } from "../dnd/use-drop-target";
import { GroupTabBar } from "./group-tab-bar";
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

  const setSlotEl = useCallback(
    (el: HTMLElement | null) => {
      slotRegistry.set(workspaceId, leaf.id, el);
    },
    [workspaceId, leaf.id],
  );

  // D&D drop target — uses native addEventListener (not React onDrop) because
  // ContentHost is injected via createPortal, and React-tree event dispatch
  // bypasses DOM-tree ancestors. Native bubble follows the DOM tree and
  // therefore reaches us.
  //
  // attachRef → outer wrapper (covers tab-bar + content slot) so the cursor
  //             anywhere in the group lands on us, including the tab-bar.
  // zoneRef   → content slot only, used for 5-zone classification. Cursor
  //             over the tab-bar is outside this rect → classified as
  //             "center" (drop "into the group").
  const { dropZone, attachRef, zoneRef } = useDropTarget({ workspaceId, groupId: leaf.id });

  // Merge slotRegistry callback with the dnd zoneRef on the slot div.
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
      ref={attachRef}
      className={cn("flex flex-col min-h-0 min-w-0 flex-1", isActive && "bg-frosted-veil")}
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
        onActivateGroup={onActivateGroup}
      />

      {/* Content slot — portal target registered in slotRegistry for ContentHost */}
      <div
        ref={slotRef}
        data-group-slot={leaf.id}
        className="flex-1 min-h-0 min-w-0 relative"
      >
        {showPlaceholder && <GroupPlaceholder />}
        {dropZone && <DropIndicator zone={dropZone} />}
      </div>
    </div>
  );
}
