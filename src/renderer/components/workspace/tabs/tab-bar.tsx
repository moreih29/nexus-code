import { FilePlus, Globe, Plus, SquareTerminal } from "lucide-react";
import { Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DND_TAB_BAR_ATTR } from "@/components/workspace/dnd/markers";
import { basename } from "@/utils/path";
import { UI_TOOLTIP_DELAY_MS } from "../../../../shared/util/timing-constants";
import type { EditorTab, Tab } from "../../../state/stores/tabs";
import { formatDiffRefPair } from "../../editor/format-diff-refs";
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
  onNewUntitledTab: () => void;
  onNewBrowserTab: () => void;
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
  onNewUntitledTab,
  onNewBrowserTab,
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

  // Diff 탭은 항상 `leftRef..rightRef` 보조 텍스트를 달아 같은 파일의 일반
  // 에디터 탭과 구분되게 한다. 아이콘(FileDiff vs 확장자 아이콘)으로도
  // 구분되지만 텍스트 단서가 있으면 ref가 다른 두 diff(예: HEAD..WORKING vs
  // INDEX..WORKING)도 한눈에 갈린다. external 탭의 parent-dir suffix와는
  // 슬롯(`parentDirSuffix`)을 공유하지만 diff 탭은 `editor` 타입이 아니어서
  // 두 맵의 키가 겹치지 않으므로 우선순위 충돌은 발생하지 않는다.
  const diffTabRefSuffix = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tabs) {
      if (t.type === "editor.diff") {
        map.set(t.id, formatDiffRefPair(t.props.leftRef, t.props.rightRef));
      }
    }
    return map;
  }, [tabs]);

  return (
    <RadixTooltip.Provider delayDuration={UI_TOOLTIP_DELAY_MS}>
      {/* Outer wrapper carries the data-dnd-tab-bar marker AND the drop
          listeners (via barRef) so the entire bar — including the empty
          area beyond the last tab and around the "+" button — is treated
          as a tab-bar drop zone. The inner List is used for measurement
          so the "|" insertion line is positioned relative to the actual
          tab strip. */}
      {/* role="status" aria-live="polite" — Claude 상태 변경 시 스크린리더에 안내.
          탭 글리프 aria-label이 변경되면 live region이 polite하게 알린다. */}
      <div
        ref={barRef}
        role="status"
        aria-live="polite"
        {...{ [DND_TAB_BAR_ATTR]: "" }}
        className="flex items-center h-9 shrink-0 overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                parentDirSuffix={diffTabRefSuffix.get(tab.id) ?? externalTabParentDir.get(tab.id)}
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

          {/* New tab dropdown */}
          <DropdownMenuRoot>
            <DropdownMenuTrigger>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-muted-foreground hover:text-foreground ml-0"
                aria-label="New tab"
              >
                <Plus aria-hidden width={16} height={16} strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom" sideOffset={4}>
              <DropdownMenuItem onSelect={() => onNewUntitledTab()}>
                <FilePlus aria-hidden className="size-3.5 mr-1.5 shrink-0" />
                <span className="flex-1">New File</span>
                <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onNewTerminalTab()}>
                <SquareTerminal aria-hidden className="size-3.5 mr-1.5 shrink-0" />
                <span className="flex-1">New Terminal</span>
                <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onNewBrowserTab()}>
                <Globe aria-hidden className="size-3.5 mr-1.5 shrink-0" />
                <span className="flex-1">New Browser</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
        </RadixTabs.Root>
      </div>
    </RadixTooltip.Provider>
  );
}
