import { useCallback, useEffect, useState } from "react";
import { closeEditorWithConfirm } from "@/services/editor";
import { closeTerminal, openTerminal } from "@/services/terminal";
import type { LayoutLeaf } from "@/state/stores/layout";
import { useLayoutStore } from "@/state/stores/layout";
import { useTabsStore } from "@/state/stores/tabs";
import { cn } from "@/utils/cn";
import { slotRegistry } from "../content/slot-registry";
import { DropIndicator } from "../dnd/drop-indicator";
import { useDropTarget } from "../dnd/use-drop-target";
import { GroupPlaceholder } from "./group-placeholder";
import { GroupTabBar } from "./group-tab-bar";

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
    const currentActiveTabId = leaf.activeTabId;
    layoutStore.setActiveTabInGroup({
      workspaceId,
      groupId: leaf.id,
      tabId,
      activateGroup: true,
    });
    onActivateGroup(leaf.id);
    // Re-selecting the already-active tab promotes it from preview (VSCode behaviour).
    if (tabId === currentActiveTabId) {
      useTabsStore.getState().promoteFromPreview(workspaceId, tabId);
    }
  }

  function handleCloseTab(tabId: string) {
    const tab = tabsMap[tabId];
    if (tab?.type === "terminal") {
      closeTerminal(tabId);
      return;
    }
    if (tab?.type === "editor") {
      // Fire-and-forget: close-handler runs the dirty confirm flow,
      // which is async because it may await user input. Group-view
      // doesn't react to the outcome — the close itself updates layout
      // via the tabs store, which re-renders us.
      void closeEditorWithConfirm(workspaceId, tabId);
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

  // Native focusin listener — keyboard focus moving into this group
  // (editor textarea, terminal, etc.) should make it the active group.
  // We use native addEventListener for the same reason as D&D handlers:
  // ContentHost children are inserted via createPortal and so don't
  // bubble through the React tree to this component. focusin bubbles in
  // the DOM tree, which reaches us.
  const [outerEl, setOuterEl] = useState<HTMLElement | null>(null);
  const wrapperRef = useCallback(
    (el: HTMLElement | null) => {
      setOuterEl(el);
      attachRef(el);
    },
    [attachRef],
  );
  useEffect(() => {
    if (!outerEl) return;
    const onFocusIn = () => {
      const layout = useLayoutStore.getState().byWorkspace[workspaceId];
      if (!layout || layout.activeGroupId === leaf.id) return;
      useLayoutStore.getState().setActiveGroup(workspaceId, leaf.id);
      onActivateGroup(leaf.id);
    };
    outerEl.addEventListener("focusin", onFocusIn);
    return () => outerEl.removeEventListener("focusin", onFocusIn);
  }, [outerEl, workspaceId, leaf.id, onActivateGroup]);

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
      ref={wrapperRef}
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
      <div ref={slotRef} data-group-slot={leaf.id} className="flex-1 min-h-0 min-w-0 relative">
        {showPlaceholder && <GroupPlaceholder />}
        {dropZone && <DropIndicator zone={dropZone} />}
      </div>
    </div>
  );
}
