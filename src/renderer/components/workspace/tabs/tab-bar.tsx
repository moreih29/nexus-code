import { Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useDragSource } from "@/components/ui/use-drag-source";
import { moveTabToZone, openFileAtZone } from "@/state/operations";
import { cn } from "@/utils/cn";
import type { Tab } from "../../../state/stores/tabs";
import {
  type FileDragPayload,
  MIME_FILE,
  MIME_TAB,
  type TabDragPayload,
} from "../dnd/types";

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
// The drop-target lives one level up on the tab list (TabBar). Tab items
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
      data-dnd-tab-item
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
        <span>{tab.title}</span>
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
// Component
// ---------------------------------------------------------------------------

interface InsertionState {
  /** Insertion line x in coordinates relative to the tab list element. */
  x: number;
  /** Resulting tab index for the insertion. */
  index: number;
}

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
  // Tab-bar-level drop target — VSCode pattern. dropping anywhere on the
  // tab strip shows a single "|" insertion line at the appropriate edge:
  // - empty list → x=0, index=0
  // - cursor left of tab N's center → at N's left edge, index=N
  // - cursor right of last tab's center → at last tab's right edge,
  //   index=tabs.length (drop into the trailing empty area)
  //
  // Listeners are attached to the OUTER bar container (Root), not the inner
  // List, so the cursor anywhere in the tab-bar (including the empty area
  // beyond the last tab and around the "+" button) is treated as a tab-bar
  // drop. Group-level dropTarget defers via the data-dnd-tab-bar marker on
  // the same outer container, suppressing the block indicator.
  const barRef = useRef<HTMLDivElement | null>(null);
  const tabsListRef = useRef<HTMLDivElement | null>(null);
  const [insertion, setInsertion] = useState<InsertionState | null>(null);

  useEffect(() => {
    const bar = barRef.current;
    const list = tabsListRef.current;
    if (!bar || !list) return;

    function isSupported(types: ReadonlyArray<string>): boolean {
      return types.includes(MIME_TAB) || types.includes(MIME_FILE);
    }

    function getInsertion(clientX: number): InsertionState {
      // list is non-null past the guard above; function decls don't preserve
      // narrowing into closures so we re-assert here.
      const items = Array.from(list!.querySelectorAll<HTMLElement>("[data-dnd-tab-item]"));
      const listRect = list!.getBoundingClientRect();

      if (items.length === 0) {
        return { x: 0, index: 0 };
      }

      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        const center = r.left + r.width / 2;
        if (clientX < center) {
          return { x: r.left - listRect.left, index: i };
        }
      }

      const lastRect = items[items.length - 1].getBoundingClientRect();
      return { x: lastRect.right - listRect.left, index: items.length };
    }

    function onEnter(e: DragEvent) {
      if (!e.dataTransfer || !isSupported(e.dataTransfer.types)) return;
      e.stopPropagation();
      setInsertion(getInsertion(e.clientX));
    }

    function onOver(e: DragEvent) {
      if (!e.dataTransfer || !isSupported(e.dataTransfer.types)) return;
      e.preventDefault();
      e.stopPropagation();
      const isFile = e.dataTransfer.types.includes(MIME_FILE);
      e.dataTransfer.dropEffect = isFile ? "copy" : "move";
      const next = getInsertion(e.clientX);
      setInsertion((prev) =>
        prev && prev.x === next.x && prev.index === next.index ? prev : next,
      );
    }

    function onLeave(e: DragEvent) {
      if (!e.dataTransfer || !isSupported(e.dataTransfer.types)) return;
      e.stopPropagation();
      // dragleave fires for every descendant exit; only clear when the
      // cursor truly leaves the bar.
      const related = e.relatedTarget as Node | null;
      if (related && bar!.contains(related)) return;
      setInsertion(null);
    }

    function onDrop(e: DragEvent) {
      if (!e.dataTransfer) return;
      const tabRaw = e.dataTransfer.getData(MIME_TAB);
      const fileRaw = e.dataTransfer.getData(MIME_FILE);
      if (!tabRaw && !fileRaw) {
        setInsertion(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const next = getInsertion(e.clientX);

      try {
        if (tabRaw) {
          let parsed: TabDragPayload;
          try {
            parsed = JSON.parse(tabRaw) as TabDragPayload;
          } catch {
            return;
          }
          if (parsed.workspaceId !== workspaceId) return;
          moveTabToZone(workspaceId, parsed.tabId, {
            groupId: leafId,
            zone: "center",
            index: next.index,
          });
        } else if (fileRaw) {
          let parsed: FileDragPayload;
          try {
            parsed = JSON.parse(fileRaw) as FileDragPayload;
          } catch {
            return;
          }
          if (parsed.workspaceId !== workspaceId) return;
          openFileAtZone(workspaceId, parsed.filePath, {
            groupId: leafId,
            zone: "center",
            index: next.index,
          });
        }
      } finally {
        setInsertion(null);
      }
    }

    bar.addEventListener("dragenter", onEnter, true);
    bar.addEventListener("dragover", onOver, true);
    bar.addEventListener("dragleave", onLeave, true);
    bar.addEventListener("drop", onDrop, true);

    return () => {
      bar.removeEventListener("dragenter", onEnter, true);
      bar.removeEventListener("dragover", onOver, true);
      bar.removeEventListener("dragleave", onLeave, true);
      bar.removeEventListener("drop", onDrop, true);
    };
  }, [workspaceId, leafId, tabs.length]);

  return (
    <RadixTooltip.Provider delayDuration={600}>
      {/* Outer wrapper carries the data-dnd-tab-bar marker AND the drop
          listeners so the entire bar (including the empty area beyond the
          last tab and around the "+" button) is treated as a tab-bar drop
          zone. The inner List is still used for measurement so the "|"
          insertion line is positioned relative to the actual tab strip. */}
      <div
        ref={barRef}
        data-dnd-tab-bar
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
              dragover. Visible only while a supported drag is over the list. */}
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
