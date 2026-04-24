import { Folder, GitBranch, Search, Settings, Wrench, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

interface ActivityBarItem {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
}

const ACTIVITY_BAR_ITEMS: ActivityBarItem[] = [
  { icon: Folder, label: "Workspaces" },
  { icon: Search, label: "Search", disabled: true },
  { icon: GitBranch, label: "Git status", disabled: true },
  { icon: Wrench, label: "Tools", disabled: true },
  { icon: Settings, label: "Settings", disabled: true },
];

export function ActivityBar() {
  return (
    <TooltipProvider>
      <nav
        aria-label="Primary"
        className="flex h-full w-12 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar py-2 text-sidebar-foreground"
      >
        <div className="flex flex-col gap-1">
          {ACTIVITY_BAR_ITEMS.map((item, index) => (
            <ActivityBarButton key={item.label} item={item} active={index === 0} />
          ))}
        </div>
      </nav>
    </TooltipProvider>
  );
}

function ActivityBarButton({ active, item }: { active: boolean; item: ActivityBarItem }) {
  const Icon = item.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={item.label}
          aria-current={active ? "page" : undefined}
          disabled={item.disabled}
          className={cn(
            "flex size-9 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
            active && "bg-accent text-accent-foreground",
            !active && !item.disabled && "hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <Icon aria-hidden="true" size={20} strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}
