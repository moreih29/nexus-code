import { Folder, Server } from "lucide-react";
import { cn } from "@/utils/cn";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { useUIStore } from "../../state/stores/ui";
import type { WorkspaceConnectionStatus } from "../../state/stores/workspaces";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { SidebarResizeHandle } from "./sidebar-resize-handle";

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
  const connectionStatusByWorkspaceId = useWorkspacesStore((s) => s.connectionStatusByWorkspaceId);

  return (
    // bg-muted = surface.chrome.bg (L1). border-r = surface.chrome.border hairline:
    // P3 zone boundary between sidebar (L1) and FilesPanel/canvas (L2/L0).
    <aside className="relative shrink-0 bg-muted border-r border-border flex flex-col" style={{ width: sidebarWidth }}>
      <div className="py-3 flex-1 overflow-y-auto app-scrollbar">
        {workspaces.length === 0 && (
          <div className="px-4 py-6 text-center text-app-ui-sm text-muted-foreground">
            No workspaces yet.
            <br />
            Add one to get started.
          </div>
        )}

        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          const isSsh = ws.location.kind === "ssh";
          const Icon = isSsh ? Server : Folder;
          const connectionStatus: WorkspaceConnectionStatus = isSsh
            ? (connectionStatusByWorkspaceId[ws.id] ?? "idle")
            : "idle";
          const secondaryText = secondaryWorkspaceText(ws);
          const secondaryTitle = ws.location.kind === "ssh" ? ws.location.remotePath : ws.rootPath;

          return (
            <div key={ws.id} className="relative group mx-2 my-0.5">
              <button
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => onSelectWorkspace(ws.id)}
                className={cn(
                  // base layout — left accent bar reserved (border-l-2 transparent) so width is stable across states
                  "block w-full px-4 py-2 rounded-[--radius-container] border-l-2 border-l-transparent",
                  // reserve right space so the × button never overlaps text
                  "pr-8",
                  // text + interaction
                  "text-left cursor-pointer select-none font-sans transition-colors",
                  // rest state: state.hover.bg overlay (light-theme safe, design.md §7)
                  "text-foreground bg-transparent hover:bg-[var(--state-hover-bg)]",
                  // active state: state.hover.bg bg + surface.chrome.border left accent hairline
                  isActive && "bg-[var(--state-hover-bg)] border-l-border",
                )}
              >
                <span className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-2">
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0">
                    {/* Workspace name — 14px body, truncate for long names */}
                    <span
                      className={cn(
                        "block text-app-body-emphasis truncate min-w-0",
                        isActive ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {ws.name}
                    </span>
                    {/* Location hint — micro: 11px, truncate */}
                    <span
                      className="block text-micro text-muted-foreground mt-[2px] truncate min-w-0"
                      title={secondaryTitle}
                    >
                      {secondaryText}
                    </span>
                  </span>
                </span>
              </button>

              {isSsh && <ConnectionStatusDot status={connectionStatus} />}

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
                  "size-5 rounded-[--radius-control] text-app-body-emphasis leading-none",
                  "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
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
            "block w-[calc(100%-16px)] mx-2 px-4 py-2 rounded-[--radius-container]",
            "text-left cursor-pointer select-none font-sans transition-colors",
            "text-app-body text-muted-foreground bg-transparent",
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

/**
 * Renders the compact SSH connection indicator with text for assistive tech.
 */
function ConnectionStatusDot({ status }: { status: WorkspaceConnectionStatus }) {
  const label = `SSH workspace, ${status}`;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        "absolute bottom-2 right-2 size-2 rounded-full ring-1 ring-background",
        connectionStatusClassName(status),
      )}
    />
  );
}

/**
 * Maps sidebar display statuses to measured OKLCH token colors.
 */
function connectionStatusClassName(status: WorkspaceConnectionStatus): string {
  switch (status) {
    case "connected":
      return "bg-[var(--color-workspace-connection-connected)]";
    case "connecting":
    case "reconnecting":
      return "bg-[var(--color-workspace-connection-connecting)]";
    case "error":
      return "bg-[var(--color-workspace-connection-error)]";
    case "idle":
      return "bg-[var(--color-workspace-connection-idle)]";
  }
}

/**
 * Chooses the compact secondary line for local and SSH workspace rows.
 */
function secondaryWorkspaceText(workspace: WorkspaceMeta): string {
  if (workspace.location.kind === "ssh") {
    if (workspace.location.configAlias) {
      return workspace.location.configAlias;
    }
    return workspace.location.user
      ? `${workspace.location.user}@${workspace.location.host}`
      : workspace.location.host;
  }

  return workspace.rootPath.split("/").filter(Boolean).slice(-2).join("/");
}
