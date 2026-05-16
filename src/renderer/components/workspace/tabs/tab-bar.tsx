import { Plus } from "lucide-react";
import { Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { DND_TAB_BAR_ATTR } from "@/components/workspace/dnd/markers";
import { basename } from "@/utils/path";
import { UI_TOOLTIP_DELAY_MS } from "../../../../shared/util/timing-constants";
import type { EditorTab, Tab } from "../../../state/stores/tabs";
import { useTabBarDropTarget } from "../dnd/use-tab-bar-drop-target";
import { TabItem } from "./tab-item";

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

  // Stable sort: pinned group first, then unpinned — original order preserved within each group.
  const sortedTabs = useMemo(() => {
    const pinned = tabs.filter((t) => t.isPinned);
    const unpinned = tabs.filter((t) => !t.isPinned);
    return [...pinned, ...unpinned];
  }, [tabs]);

  // Basename collision disambiguation for external tabs in this group.
  // When ≥2 external editor tabs share the same basename, append the parent
  // directory name as a suffix so the user can distinguish them.
  const externalTabParentDir = useMemo(() => {
    const suffixMap = new Map<string, string | undefined>();
    const externalTabs = tabs.filter(
      (t): t is EditorTab => t.type === "editor" && t.props.origin === "external",
    );
    // Count how many external tabs share each basename.
    const basenameCount = new Map<string, number>();
    for (const t of externalTabs) {
      const name = basename(t.props.filePath);
      basenameCount.set(name, (basenameCount.get(name) ?? 0) + 1);
    }
    for (const t of externalTabs) {
      const name = basename(t.props.filePath);
      if ((basenameCount.get(name) ?? 0) > 1) {
        // Extract the parent dir name from the absolute path.
        const parts = t.props.filePath.split("/");
        const parentDir = parts.length >= 2 ? parts[parts.length - 2] : undefined;
        suffixMap.set(t.id, parentDir);
      }
    }
    return suffixMap;
  }, [tabs]);

  return (
    <RadixTooltip.Provider delayDuration={UI_TOOLTIP_DELAY_MS}>
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
            {sortedTabs.map((tab) => (
              // Wrapper makes the close button a sibling of the trigger so
              // <button> is never nested inside <button> (HTML invalid; React
              // 19 hydration warning). Same pattern as Sidebar.tsx workspace
              // × button.
              <TabItem
                key={tab.id}
                workspaceId={workspaceId}
                leafId={leafId}
                tab={tab}
                displayTitle={tab.title}
                parentDirSuffix={externalTabParentDir.get(tab.id)}
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
            <Plus aria-hidden width={16} height={16} strokeWidth={1.5} />
          </Button>
        </RadixTabs.Root>
      </div>
    </RadixTooltip.Provider>
  );
}
