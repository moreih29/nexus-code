import { Eye, Files, GitBranch, History, Search, Wrench, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
export type ActivityBarViewId = string;
export type DefaultActivityBarViewId =
  | "explorer"
  | "search"
  | "source-control"
  | "tool"
  | "session"
  | "preview";

export interface ActivityBarView {
  id: ActivityBarViewId;
  label: string;
  sideBarTitle: string;
  sideBarContentId: string;
}

export interface ActivityBarPartProps {
  views: readonly ActivityBarView[];
  activeViewId: ActivityBarViewId;
  sideBarCollapsed?: boolean;
  onActiveViewChange(viewId: ActivityBarViewId): void;
}

const VIEW_ICONS: Record<DefaultActivityBarViewId, LucideIcon> = {
  explorer: Files,
  search: Search,
  "source-control": GitBranch,
  tool: Wrench,
  session: History,
  preview: Eye,
};

export function ActivityBarPart({
  views,
  activeViewId,
  sideBarCollapsed = false,
  onActiveViewChange,
}: ActivityBarPartProps): JSX.Element {
  return (
    <nav
      data-component="activity-bar"
      data-side-bar-collapsed={sideBarCollapsed ? "true" : "false"}
      aria-label="Activity Bar"
      className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-card/80 py-2 text-muted-foreground"
    >
      <div role="tablist" aria-orientation="vertical" className="flex w-full flex-col items-center gap-1">
        {views.map((view) => {
          const active = view.id === activeViewId;
          const Icon = iconForView(view.id);

          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={view.label}
              title={view.label}
              data-activity-view={view.id}
              data-active={active ? "true" : "false"}
              className={cn(
                "flex size-9 items-center justify-center rounded-md transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-ring",
                active
                  ? "bg-accent text-accent-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
              )}
              onClick={() => onActiveViewChange(view.id)}
            >
              <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
              <span className="sr-only">{view.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function iconForView(viewId: ActivityBarViewId): LucideIcon {
  return VIEW_ICONS[viewId as DefaultActivityBarViewId] ?? Files;
}
