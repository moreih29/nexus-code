import { Folder, Server, X } from "lucide-react";
import { cn } from "@/utils/cn";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { useUIStore } from "../../state/stores/ui";
import type { WorkspaceConnectionStatus } from "../../state/stores/workspaces";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import {
  folderName,
  formatSshSecondaryLine,
  formatSshTooltip,
} from "../workspace/add-workspace/ssh-helpers";
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
    // Islands model (design.md §2): <aside> is a transparent positioning shell;
    // island surface lives on the inner wrapper so overflow-hidden clips content
    // without clipping the absolute-positioned <SidebarResizeHandle>.
    <aside className="relative shrink-0 flex flex-col" style={{ width: sidebarWidth }}>
      <div className="flex flex-col flex-1 min-h-0 island-surface rounded-(--radius-island) overflow-hidden">
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

            // For SSH: primary = remote folder leaf, secondary = user@host,
            // title = full connection + path for tooltip.
            // For local: primary = ws.name, secondary = parent/folder, title = full path.
            const sshLocation = ws.location.kind === "ssh" ? ws.location : null;
            const primaryText = sshLocation ? folderName(sshLocation.remotePath) : ws.name;
            const secondaryText = secondaryWorkspaceText(ws);
            const secondaryTitle = sshLocation
              ? formatSshTooltip({
                  user: sshLocation.user,
                  host: sshLocation.host,
                  port: sshLocation.port,
                  remotePath: sshLocation.remotePath,
                })
              : ws.rootPath;

            return (
              <div key={ws.id} className="relative group mx-2 my-0.5">
                <button
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => onSelectWorkspace(ws.id)}
                  className={cn(
                    // base layout — left accent bar reserved (border-l-2 transparent) so width is stable across states
                    "block w-full px-4 py-2 rounded-(--radius-control) border-l-2 border-l-transparent",
                    // reserve right space so the remove button never overlaps text
                    "pr-8",
                    // text + interaction
                    "text-left cursor-pointer select-none font-sans transition-colors",
                    "text-foreground",
                    // selected state: sidebar.item.selected.bg bg + state.selected.indicator 2px left accent
                    // Shared single-language token with tab selection (plan #48 C-1, design.md §7).
                    isActive
                      ? "bg-[var(--sidebar-item-selected-bg)] border-l-[var(--state-selected-indicator)]"
                      : // rest/hover state: transparent bg + state.hover.bg on hover (light-theme safe, design.md §7)
                        "bg-transparent hover:bg-[var(--state-hover-bg)]",
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
                        {primaryText}
                      </span>
                      {/* Location hint — micro: 11px, truncate */}
                      <span
                        className="block text-app-micro text-muted-foreground mt-0.5 truncate min-w-0"
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
                    "size-5 rounded-(--radius-control)",
                    "text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
                    "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity",
                  )}
                >
                  <X className="size-3" aria-hidden="true" />
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
              "block w-[calc(100%-16px)] mx-2 px-4 py-2 rounded-(--radius-control)",
              "text-left cursor-pointer select-none font-sans transition-colors",
              "text-app-body text-muted-foreground bg-transparent",
              "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
            )}
            aria-label="Add workspace"
          >
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true">+</span>
              <span>Add workspace</span>
            </span>
          </button>
        </div>
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
 * SSH: always `user@host` (configAlias is dropped in favour of connection info visibility).
 * Local: last two path segments for breadcrumb context.
 */
function secondaryWorkspaceText(workspace: WorkspaceMeta): string {
  if (workspace.location.kind === "ssh") {
    return formatSshSecondaryLine({
      user: workspace.location.user,
      host: workspace.location.host,
    });
  }

  return workspace.rootPath.split("/").filter(Boolean).slice(-2).join("/");
}
