import { Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useDragSource } from "@/components/ui/use-drag-source";
import { DND_TAB_BAR_ATTR, DND_TAB_ITEM_ATTR } from "@/components/workspace/dnd/markers";
import { cn } from "@/utils/cn";
import type { Tab } from "../../../state/stores/tabs";
import { MIME_TAB, type TabDragPayload } from "../dnd/types";
import { useTabBarDropTarget } from "../dnd/use-tab-bar-drop-target";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TabBarProps {
  workspaceId: string;
  leafId: string;
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTerminalTab: () => void;
  onTabContextMenu?: (tabId: string, event: React.MouseEvent) => void;
}

// ---------------------------------------------------------------------------
// Single tab item — split out so each can call useDragSource (rules of hooks
// forbid calling hooks inside a .map iteration on the parent).
//
// The drop-target lives one level up on the tab bar (TabBar). Tab items
// here are drag *sources* only; the indicator they show comes from a single
// "|" element rendered by TabBar at the computed insertion x.
// ---------------------------------------------------------------------------

interface TabItemProps {
  workspaceId: string;
  leafId: string;
  tab: Tab;
  onCloseTab: (id: string) => void;
  onTabContextMenu?: (tabId: string, event: React.MouseEvent) => void;
}

function TabItem({ workspaceId, leafId, tab, onCloseTab, onTabContextMenu }: TabItemProps) {
  const payload = useMemo<TabDragPayload>(
    () => ({ workspaceId, tabId: tab.id, sourceGroupId: leafId }),
    [workspaceId, tab.id, leafId],
  );

  // VSCode anchors the drag image at (0, 0) of the tab DOM so the cursor sits
  // at the top-left corner, leaving room for drop-border feedback.
  const { onDragStart } = useDragSource({
    mime: MIME_TAB,
    payload,
    dragImage: { kind: "self" },
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper owns context menu and drag source; trigger handles tab keyboard interaction
    <div
      key={tab.id}
      className="relative flex items-center h-full"
      {...{ [DND_TAB_ITEM_ATTR]: "" }}
      draggable
      onDragStart={onDragStart}
      onContextMenu={(e) => onTabContextMenu?.(tab.id, e)}
    >
      <RadixTabs.Trigger
        value={tab.id}
        className={cn(
          // base layout — pr-7 reserves space for the absolute × button
          "flex items-center gap-1.5 pl-3 pr-7 h-full",
          // text
          "text-app-ui-sm whitespace-nowrap select-none cursor-pointer",
          // rest state
          "text-muted-foreground hover:bg-frosted-veil-strong hover:text-foreground",
          // active state: frosted veil bg + mist-border bottom indicator (1px, mist-border token)
          "data-[state=active]:bg-frosted-veil data-[state=active]:text-foreground data-[state=active]:border-b data-[state=active]:border-b-mist-border",
          // focus
          "outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50",
          // reset button defaults
          "bg-transparent",
        )}
      >
        <span className={tab.isPreview ? "italic" : undefined}>{tab.title}</span>
      </RadixTabs.Trigger>

      {/* Close button with Tooltip — sibling of trigger */}
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-1 top-1/2 -translate-y-1/2 size-4 opacity-50 hover:opacity-100 hover:bg-frosted-veil-strong shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            aria-label="Close tab"
          >
            ×
          </Button>
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className="px-2 py-1 text-micro bg-muted text-foreground border border-border rounded-[4px] shadow-none"
            sideOffset={4}
          >
            Close tab
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabBar — renders the bar wrapper (drop-target carrier) + tab list
// (measurement basis) + "+" button. The D&D logic lives in the
// useTabBarDropTarget hook; TabBar wires the returned refs into the JSX
// and renders the "|" indicator at the hook-computed x.
// ---------------------------------------------------------------------------

export function TabBar({
  workspaceId,
  leafId,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTerminalTab,
  onTabContextMenu,
}: TabBarProps) {
  const { barRef, tabsListRef, insertion } = useTabBarDropTarget({ workspaceId, leafId });

  return (
    <RadixTooltip.Provider delayDuration={600}>
      {/* Outer wrapper carries the data-dnd-tab-bar marker AND the drop
          listeners (via barRef) so the entire bar — including the empty
          area beyond the last tab and around the "+" button — is treated
          as a tab-bar drop zone. The inner List is used for measurement
          so the "|" insertion line is positioned relative to the actual
          tab strip. */}
      <div
        ref={barRef}
        {...{ [DND_TAB_BAR_ATTR]: "" }}
        className="flex items-center h-9 shrink-0 bg-muted overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <RadixTabs.Root
          value={activeTabId ?? ""}
          onValueChange={onSelectTab}
          className="flex items-center h-full w-full"
        >
          <RadixTabs.List
            ref={tabsListRef}
            className="relative flex items-center h-full"
            aria-label="Open tabs"
          >
            {tabs.map((tab) => (
              // Wrapper makes the close button a sibling of the trigger so
              // <button> is never nested inside <button> (HTML invalid; React
              // 19 hydration warning). Same pattern as Sidebar.tsx workspace
              // × button.
              <TabItem
                key={tab.id}
                workspaceId={workspaceId}
                leafId={leafId}
                tab={tab}
                onCloseTab={onCloseTab}
                onTabContextMenu={onTabContextMenu}
              />
            ))}

            {/* Single "|" insertion-line indicator. Position is recomputed on
                dragover. Visible only while a supported drag is over the bar. */}
            {insertion && (
              <div
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-primary"
                style={{ left: insertion.x, transform: "translateX(-1px)" }}
              />
            )}
          </RadixTabs.List>

          {/* New terminal tab button */}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-foreground ml-0"
            onClick={onNewTerminalTab}
            aria-label="New terminal tab"
          >
            +
          </Button>
        </RadixTabs.Root>
      </div>
    </RadixTooltip.Provider>
  );
}
