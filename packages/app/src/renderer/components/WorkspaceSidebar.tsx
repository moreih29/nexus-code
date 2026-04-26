import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace-shell";
import { FolderOpen, X } from "lucide-react";

import { cn } from "../lib/utils";
import type { HarnessWorkspaceBadge } from "../stores/harnessBadgeStore";
import { keyboardRegistryStore } from "../stores/keyboard-registry";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

export interface WorkspaceSidebarProps {
  sidebarState: WorkspaceSidebarState;
  badgeByWorkspaceId?: Record<string, HarnessWorkspaceBadge>;
  onOpenFolder(): Promise<void>;
  onActivateWorkspace(workspaceId: WorkspaceId): Promise<void>;
  onCloseWorkspace(workspaceId: WorkspaceId): Promise<void>;
}

export function WorkspaceSidebar({
  sidebarState,
  badgeByWorkspaceId = {},
  onOpenFolder,
  onActivateWorkspace,
  onCloseWorkspace,
}: WorkspaceSidebarProps): JSX.Element {
  const workspaceCount = sidebarState.openWorkspaces.length;

  return (
    <section
      data-component="workspace-sidebar"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar/80 p-2 text-sidebar-foreground"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 px-1 pb-2">
        <div className="min-w-0">
          <h2 className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-sidebar-foreground">
            Workspaces
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {workspaceCount === 1 ? "1 open" : `${workspaceCount} open`}
          </p>
        </div>
        <Button
          type="button"
          data-action="open-folder"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 px-2 text-xs"
          onClick={() => {
            void onOpenFolder();
          }}
        >
          Open Folder…
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <ol className="flex min-w-0 flex-col gap-1.5 pr-1">
          {sidebarState.openWorkspaces.map((workspace) => {
            const isActive = workspace.id === sidebarState.activeWorkspaceId;
            const badge = badgeByWorkspaceId[workspace.id];
            const workspaceAriaLabel = badge
              ? `${workspace.displayName}: ${badgeStateLabel(badge.state)}`
              : workspace.displayName;

            return (
              <li
                key={workspace.id}
                data-active={isActive ? "true" : "false"}
                className={cn(
                  "group overflow-hidden rounded-lg border border-sidebar-border bg-card/40 transition-colors",
                  "hover:border-zinc-700 hover:bg-card/70",
                  isActive && "border-primary/50 bg-accent/70 ring-1 ring-primary/25",
                )}
              >
                <div className="flex min-h-12 min-w-0 items-center gap-2 p-2">
                  <button
                    type="button"
                    data-action="activate-workspace"
                    data-workspace-id={workspace.id}
                    data-active={isActive ? "true" : "false"}
                    aria-current={isActive ? "page" : "false"}
                    aria-label={workspaceAriaLabel}
                    className={cn(
                      "grid min-w-0 flex-1 gap-1 rounded-sm text-left text-sidebar-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                    onClick={() => {
                      void onActivateWorkspace(workspace.id);
                    }}
                  >
                    <span className="w-full truncate text-sm font-semibold leading-tight text-foreground">
                      {workspace.displayName}
                    </span>
                    <small className="w-full truncate font-mono text-xs leading-tight text-muted-foreground">
                      {workspace.absolutePath}
                    </small>
                  </button>
                  {badge ? (
                    <>
                      <span
                        data-harness-badge-state={badge.state}
                        className={cn(
                          "block size-2 shrink-0 rounded-full",
                          badge.state === "running" && "bg-status-running",
                          badge.state === "awaiting-approval" && "bg-status-attention",
                          badge.state === "error" && "bg-destructive",
                        )}
                        aria-hidden="true"
                      />
                      <span className="sr-only">{badgeStateLabel(badge.state)}</span>
                    </>
                  ) : null}
                  <Button
                    type="button"
                    data-action="close-workspace"
                    data-workspace-id={workspace.id}
                    aria-label={`Close ${workspace.displayName}`}
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground opacity-70 hover:text-foreground hover:opacity-100"
                    onClick={() => {
                      void onCloseWorkspace(workspace.id);
                    }}
                  >
                    <X size={14} strokeWidth={1.75} />
                  </Button>
                </div>
              </li>
            );
          })}

          {sidebarState.openWorkspaces.length === 0 ? (
            <li className="h-48 rounded-md border border-dashed border-sidebar-border">
              <EmptyState
                icon={FolderOpen}
                title="No workspace open"
                description="Open a folder to add a workspace."
                action={{
                  label: "Open folder",
                  shortcut: "⌘O",
                  onClick: () => {
                    void keyboardRegistryStore.getState().executeCommand("workspace.openFolder");
                  },
                }}
              />
            </li>
          ) : null}
        </ol>
      </ScrollArea>
    </section>
  );
}

function badgeStateLabel(state: HarnessWorkspaceBadge["state"]): string {
  switch (state) {
    case "running":
      return "도구 실행 중";
    case "awaiting-approval":
      return "터미널에서 승인 대기 중";
    case "error":
      return "하네스 오류";
  }
}
