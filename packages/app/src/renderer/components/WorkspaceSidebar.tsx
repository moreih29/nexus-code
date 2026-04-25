import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace-shell";
import { FolderOpen, X } from "lucide-react";

import { cn } from "../lib/utils";
import { keyboardRegistryStore } from "../stores/keyboard-registry";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

export interface WorkspaceSidebarProps {
  sidebarState: WorkspaceSidebarState;
  onOpenFolder(): Promise<void>;
  onActivateWorkspace(workspaceId: WorkspaceId): Promise<void>;
  onCloseWorkspace(workspaceId: WorkspaceId): Promise<void>;
}

export function WorkspaceSidebar({
  sidebarState,
  onOpenFolder,
  onActivateWorkspace,
  onCloseWorkspace,
}: WorkspaceSidebarProps): JSX.Element {
  return (
    <section data-component="workspace-sidebar" className="flex min-h-0 flex-1 flex-col bg-sidebar p-2 text-sidebar-foreground">
      <header className="flex items-center justify-end gap-2">
        <Button
          type="button"
          data-action="open-folder"
          variant="outline"
          size="sm"
          className="h-8 text-sm"
          onClick={() => {
            void onOpenFolder();
          }}
        >
          Open Folder…
        </Button>
      </header>

      <ScrollArea className="mt-2 min-h-0 flex-1">
        <ol className="flex flex-col gap-1">
          {sidebarState.openWorkspaces.map((workspace) => {
            const isActive = workspace.id === sidebarState.activeWorkspaceId;

            return (
              <li key={workspace.id} className="rounded-md border border-sidebar-border bg-sidebar">
                <div className="flex h-9 items-center gap-1 p-1">
                  <button
                    type="button"
                    data-action="activate-workspace"
                    data-workspace-id={workspace.id}
                    data-active={isActive ? "true" : "false"}
                    aria-current={isActive ? "page" : "false"}
                    className={cn(
                      "flex h-7 min-w-0 flex-1 flex-col items-start justify-center rounded px-2 text-left text-base text-sidebar-foreground hover:bg-accent hover:text-accent-foreground",
                      isActive && "bg-accent text-accent-foreground",
                    )}
                    onClick={() => {
                      void onActivateWorkspace(workspace.id);
                    }}
                  >
                    <span className="w-full truncate font-medium leading-none">{workspace.displayName}</span>
                    <small className="mt-0.5 w-full truncate font-mono text-xs leading-none text-muted-foreground">
                      {workspace.absolutePath}
                    </small>
                  </button>
                  <Button
                    type="button"
                    data-action="close-workspace"
                    data-workspace-id={workspace.id}
                    aria-label={`Close ${workspace.displayName}`}
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
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
