import { cn } from "@/lib/utils";
import type { WorkspaceMeta } from "../../shared/types/workspace";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SidebarProps {
  workspaces: WorkspaceMeta[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar({ workspaces, activeWorkspaceId, onSelectWorkspace }: SidebarProps) {
  return (
    <aside className="w-[240px] shrink-0 bg-muted overflow-y-auto">
      <div className="py-3">
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          const pathTail = ws.rootPath.split("/").filter(Boolean).slice(-2).join("/");

          return (
            <button
              key={ws.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelectWorkspace(ws.id)}
              className={cn(
                // base layout — left accent bar reserved (border-l-2 transparent) so width is stable across states
                "block w-[calc(100%-16px)] mx-2 my-0.5 px-4 py-2 rounded-[6px] border-l-2 border-l-transparent",
                // text + interaction
                "text-left cursor-pointer select-none font-sans transition-colors",
                // rest state
                "text-foreground bg-transparent hover:bg-[--color-frosted-veil]",
                // active state: frosted veil bg + left accent bar (mist-border tone)
                isActive && "bg-[--color-frosted-veil] border-l-[--color-mist-border]",
              )}
            >
              {/* Category label — smallLabel: 11px, tracking 1.4px, uppercase */}
              {ws.category && (
                <span className="block text-[11px] font-normal tracking-[1.4px] uppercase text-muted-foreground leading-none mb-[3px]">
                  {ws.category}
                </span>
              )}
              {/* Workspace name — 14px body, truncate for long names */}
              <span
                className={cn(
                  "block text-[14px] font-normal leading-[1.4] tracking-[-0.14px] truncate min-w-0",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {ws.name}
              </span>
              {/* Path tail — micro: 11px, truncate */}
              <span className="block text-[11px] font-normal leading-[1.2] text-muted-foreground mt-[2px] truncate min-w-0">
                {pathTail}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
