import { cn } from "@/lib/utils";
import type { WorkspaceMeta } from "../../shared/types/workspace";
import { useUIStore } from "../store/ui";
import { SidebarResizeHandle } from "./SidebarResizeHandle";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SidebarProps {
  workspaces: WorkspaceMeta[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  onRemoveWorkspace: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Sidebar({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace,
}: SidebarProps) {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);

  return (
    <aside className="relative shrink-0 bg-muted flex flex-col" style={{ width: sidebarWidth }}>
      <div className="py-3 flex-1 overflow-y-auto">
        {workspaces.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground leading-[1.5]">
            No workspaces yet.
            <br />
            Add one to get started.
          </div>
        )}

        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          const pathTail = ws.rootPath.split("/").filter(Boolean).slice(-2).join("/");

          return (
            <div key={ws.id} className="relative group mx-2 my-0.5">
              <button
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => onSelectWorkspace(ws.id)}
                className={cn(
                  // base layout — left accent bar reserved (border-l-2 transparent) so width is stable across states
                  "block w-full px-4 py-2 rounded-[6px] border-l-2 border-l-transparent",
                  // reserve right space so the × button never overlaps text
                  "pr-8",
                  // text + interaction
                  "text-left cursor-pointer select-none font-sans transition-colors",
                  // rest state
                  "text-foreground bg-transparent hover:bg-[--color-frosted-veil]",
                  // active state: frosted veil bg + left accent bar (mist-border tone)
                  isActive && "bg-[--color-frosted-veil] border-l-[--color-mist-border]",
                )}
              >
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

              {/* Remove button — appears on hover, sibling (not nested) so HTML stays valid */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveWorkspace(ws.id);
                }}
                aria-label={`Remove workspace ${ws.name}`}
                className={cn(
                  "absolute top-1/2 -translate-y-1/2 right-2 inline-flex items-center justify-center",
                  "size-5 rounded-[4px] text-[14px] leading-none",
                  "text-muted-foreground hover:bg-[--color-frosted-veil-strong] hover:text-foreground",
                  "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity",
                )}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="py-2">
        <button
          type="button"
          onClick={onAddWorkspace}
          className={cn(
            "block w-[calc(100%-16px)] mx-2 px-4 py-2 rounded-[6px]",
            "text-left cursor-pointer select-none font-sans transition-colors",
            "text-[13px] text-muted-foreground bg-transparent",
            "hover:bg-earth-gray hover:text-foreground",
          )}
          aria-label="Add workspace"
        >
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true">+</span>
            <span>Add workspace</span>
          </span>
        </button>
      </div>
      <SidebarResizeHandle />
    </aside>
  );
}
