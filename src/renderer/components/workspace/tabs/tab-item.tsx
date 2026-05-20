import { Lock, X } from "lucide-react";
import { Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useDragSource } from "@/components/ui/use-drag-source";
import { DND_TAB_ITEM_ATTR } from "@/components/workspace/dnd/markers";
import { cacheUriFor } from "@/services/editor/model/cache";
import { isDirty, subscribeFileDirty } from "@/services/editor/model/dirty-tracker";
import { cn } from "@/utils/cn";
import { type Tab, useTabsStore } from "../../../state/stores/tabs";
import { MIME_TAB, type TabDragPayload } from "../dnd/types";

function PinIcon() {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative pin icon, hidden via aria-hidden
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17H19V16L17 10V5H18V3H6V5H7V10L5 16V17Z" />
    </svg>
  );
}

/**
 * Subscribe to dirty state for an editor tab. Returns false for
 * non-editor tabs and for tabs whose model has not yet been attached
 * (the tracker creates entries lazily on model load).
 */
function useTabDirty(tab: Tab): boolean {
  const cacheUri =
    tab.type === "editor"
      ? cacheUriFor(tab.props.workspaceId, tab.props.filePath)
      : null;
  const subscribe = useCallback(
    (cb: () => void) => (cacheUri ? subscribeFileDirty(cacheUri, cb) : () => {}),
    [cacheUri],
  );
  const getSnapshot = useCallback(() => (cacheUri ? isDirty(cacheUri) : false), [cacheUri]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export interface TabItemProps {
  workspaceId: string;
  leafId: string;
  tab: Tab;
  displayTitle: string;
  parentDirSuffix?: string;
  onCloseTab: (id: string) => void;
  onTabContextMenu?: (tabId: string, event: React.MouseEvent) => void;
}

export function TabItem({
  workspaceId,
  leafId,
  tab,
  displayTitle,
  parentDirSuffix,
  onCloseTab,
  onTabContextMenu,
}: TabItemProps) {
  const payload = useMemo<TabDragPayload>(
    () => ({ workspaceId, tabId: tab.id, sourceGroupId: leafId }),
    [workspaceId, tab.id, leafId],
  );

  const dirty = useTabDirty(tab);
  const terminalEnded = tab.type === "terminal" && Boolean(tab.props.dead);

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
      className="group relative flex items-center h-full"
      {...{ [DND_TAB_ITEM_ATTR]: "" }}
      draggable
      onDragStart={onDragStart}
      onContextMenu={(e) => onTabContextMenu?.(tab.id, e)}
      // VSCode parity: double-click on a preview tab promotes it. We have no
      // sticky/maximize behaviour to branch on (multiEditorTabsControl checks
      // `isPinned` first, but that's their *sticky* concept) — promote-only.
      onDoubleClick={() => {
        if (tab.isPreview) {
          useTabsStore.getState().promoteFromPreview(workspaceId, tab.id);
        }
      }}
    >
      <RadixTabs.Trigger
        value={tab.id}
        aria-label={terminalEnded ? `${displayTitle}, terminal ended` : undefined}
        className={cn(
          // chip layout — h-7 inset within the h-9 bar; rounded so the active /
          // hover surface reads as a raised chip (JetBrains Islands tab).
          // pr-7 reserves space for the absolute close button.
          "flex items-center gap-2 pl-3 pr-7 h-7 rounded-(--radius-raised)",
          // text
          "text-app-ui-sm whitespace-nowrap select-none cursor-pointer",
          // reset button defaults
          "bg-transparent",
          // rest (inactive): flat, muted text — no surface
          "text-muted-foreground",
          // hover: chip-shaped surface highlight (light-theme safe, design.md §8)
          "hover:bg-[var(--tab-hover-bg)] hover:text-foreground",
          // active (selected): filled raised chip + foreground text. Surface +
          // colour change satisfy §8 redundant encoding. The fill is a
          // within-island raised surface (not a canvas/island swap), so no
          // depth reversal — design.md §2 is about canvas↔island, not this.
          "data-[state=active]:bg-[var(--tab-active-bg)] data-[state=active]:text-foreground",
          // focus
          "outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50",
        )}
      >
        {tab.isPinned && <PinIcon />}
        {tab.type === "editor" && (tab.props.readOnly || tab.props.origin === "external") && (
          <span role="img" aria-label="Read-only">
            <Lock
              aria-hidden
              width={12}
              height={12}
              strokeWidth={1.5}
              className="shrink-0 text-muted-foreground"
            />
          </span>
        )}
        <span className={tab.isPreview ? "italic" : undefined}>
          {displayTitle}
          {terminalEnded && (
            <span aria-hidden className="text-muted-foreground/60">
              {" "}
              ·
            </span>
          )}
          {parentDirSuffix && (
            <span className="text-muted-foreground/60"> · {parentDirSuffix}</span>
          )}
        </span>
        {/* Dirty indicator — inline after label so it never overlaps the close button.
            Always visible when dirty (including on hover), per design.md §7 redundant encoding. */}
        {dirty && (
          <span aria-hidden className="flex items-center justify-center size-2 shrink-0">
            <span className="size-2 rounded-full bg-[var(--tab-modified-dot)]" />
          </span>
        )}
      </RadixTabs.Trigger>

      {/* Close button with Tooltip — sibling of trigger (never nested inside trigger).
          Always positioned separately from the dirty dot (no replacement).
          Hit target is min-w-6 min-h-6 (24px) per design requirement. */}
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-1 top-1/2 -translate-y-1/2 hover:bg-[var(--state-hover-bg)] shrink-0 opacity-50 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            aria-label="Close tab"
          >
            <X aria-hidden width={12} height={12} strokeWidth={2} />
          </Button>
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className="px-2 py-1 text-app-micro bg-muted text-foreground border border-border rounded-(--radius-control) shadow-none"
            sideOffset={4}
          >
            Close tab
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </div>
  );
}
