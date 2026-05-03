import { Tabs as RadixTabs, Tooltip as RadixTooltip } from "radix-ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/cn";
import type { Tab } from "../../../store/tabs";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTerminalTab: () => void;
  onTabContextMenu?: (tabId: string, event: React.MouseEvent) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTerminalTab,
  onTabContextMenu,
}: TabBarProps) {
  return (
    <RadixTooltip.Provider delayDuration={600}>
      <RadixTabs.Root
        value={activeTabId ?? ""}
        onValueChange={onSelectTab}
        className="flex items-center h-9 shrink-0 bg-muted overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <RadixTabs.List className="flex items-center h-full" aria-label="Open tabs">
          {tabs.map((tab) => (
            // Wrapper makes the close button a sibling of the trigger so
            // <button> is never nested inside <button> (HTML invalid; React
            // 19 hydration warning). Same pattern as Sidebar.tsx workspace
            // × button.
            <div
              key={tab.id}
              className="relative flex items-center h-full"
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
          ))}
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
    </RadixTooltip.Provider>
  );
}
