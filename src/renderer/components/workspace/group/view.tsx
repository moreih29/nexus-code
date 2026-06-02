import { useCallback, useEffect, useState } from "react";
import { closeTabWithConfirm } from "@/services/editor/save/close-tab";
import { openTerminal } from "@/services/terminal";
import { openNewBrowserTab, openNewUntitledTab } from "@/state/operations/tabs";
import type { LayoutLeaf } from "@/state/stores/layout";
import { useLayoutStore } from "@/state/stores/layout";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { slotRegistry } from "../content/slot-registry";
import { DropIndicator } from "../dnd/drop-indicator";
import { useDropTarget } from "../dnd/use-drop-target";
import { GroupPlaceholder } from "./placeholder";
import { GroupTabBar } from "./tab-bar";

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

// Stable empty fallback — returning a fresh `{}` from the selector would change
// identity on every render and trip useSyncExternalStore's infinite-loop guard.
const EMPTY_TABS: Record<string, Tab> = {};

export function GroupView({
  workspaceId,
  leaf,
  onActivateGroup,
  isRootLeaf,
  workspaceRootPath,
}: GroupViewProps) {
  const activeGroupId = useLayoutStore((s) => s.byWorkspace[workspaceId]?.activeGroupId ?? null);
  const tabsMap = useTabsStore((s) => s.byWorkspace[workspaceId] ?? EMPTY_TABS);

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
    // Fire-and-forget: the dispatcher runs the dirty confirm flow (async for
    // editor and untitled tabs). Group-view doesn't react to the outcome —
    // the close itself updates layout via the tabs store, which re-renders us.
    void closeTabWithConfirm(workspaceId, tabId);
  }

  function handleNewTerminalTab() {
    openTerminal({ workspaceId, cwd: workspaceRootPath }, { groupId: leaf.id });
    onActivateGroup(leaf.id);
  }

  function handleNewUntitledTab() {
    openNewUntitledTab(workspaceId);
    onActivateGroup(leaf.id);
  }

  function handleNewBrowserTab() {
    openNewBrowserTab(workspaceId);
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
    // focusin: 키보드/마우스로 focusable 자식(Monaco textarea, terminal 등)에
    //   focus 이동 시 group 활성화.
    // mousedown: focusable 자식이 없는 컨텐츠(MarkdownPreview/HtmlPreview/SvgPreview)
    //   에서는 click 해도 focus 이벤트가 발생하지 않는다. ContentHost 가 createPortal
    //   로 mount 되어 React onClick(handleGroupClick)도 portal 분리로 catch 안 됨.
    //   native mousedown 은 DOM tree bubble 을 따라 outer wrapper 까지 도달하므로
    //   preview 패널 click 도 그룹 활성화에 잡힌다.
    const activate = () => {
      const layout = useLayoutStore.getState().byWorkspace[workspaceId];
      if (!layout || layout.activeGroupId === leaf.id) return;
      useLayoutStore.getState().setActiveGroup(workspaceId, leaf.id);
      onActivateGroup(leaf.id);
    };
    // HtmlPreview renders inside a sandboxed <iframe>. A click inside the
    // iframe does NOT bubble out of the iframe boundary, so neither focusin
    // nor mousedown above fires for it. But focus moving into the iframe blurs
    // the top window, and the parent document's activeElement becomes the
    // <iframe> element. We catch that here and activate the group the iframe
    // lives in. (Guarded so an app-switch blur, where activeElement is not our
    // iframe, is ignored; activate() is a no-op when already active.)
    const onWindowBlur = () => {
      const active = document.activeElement;
      if (active && active.tagName === "IFRAME" && outerEl.contains(active)) {
        activate();
      }
    };
    outerEl.addEventListener("focusin", activate);
    outerEl.addEventListener("mousedown", activate);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      outerEl.removeEventListener("focusin", activate);
      outerEl.removeEventListener("mousedown", activate);
      window.removeEventListener("blur", onWindowBlur);
    };
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
      className="relative flex flex-col min-h-0 min-w-0 flex-1 island-surface rounded-(--radius-island) overflow-hidden"
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
        onNewUntitledTab={handleNewUntitledTab}
        onNewBrowserTab={handleNewBrowserTab}
        onActivateGroup={onActivateGroup}
      />

      {/* Content slot — portal target registered in slotRegistry for ContentHost */}
      <div ref={slotRef} data-group-slot={leaf.id} className="flex-1 min-h-0 min-w-0 relative">
        {showPlaceholder && <GroupPlaceholder />}
        {dropZone && <DropIndicator zone={dropZone} />}
      </div>

      {/* Inactive-group focus veil — design.md §5: unfocused panes get a
          translucent backdrop-coloured veil so only the active pane stays
          sharp. Replaces the previous bright active-group ring, whose
          near-white edge read as a stray strip beside the pane.
          pointer-events-none: a click still reaches the content beneath and
          activates the group via focusin. */}
      {!isActive && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[var(--surface-island-inactive-veil)]"
        />
      )}
    </div>
  );
}
