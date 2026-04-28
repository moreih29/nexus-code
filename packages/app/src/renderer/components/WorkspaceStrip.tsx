import { useCallback, useEffect, useRef, type RefCallback } from "react";
import { Folder, FolderOpen, X } from "lucide-react";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace/workspace-shell";
import { cn } from "@/lib/utils";
import type { HarnessWorkspaceBadge } from "../stores/harnessBadgeStore";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { ScrollArea } from "./ui/scroll-area";

export interface WorkspaceStripProps {
  sidebarState: WorkspaceSidebarState;
  badgeByWorkspaceId?: Record<string, HarnessWorkspaceBadge>;
  onOpenFolder(): Promise<void> | void;
  onActivateWorkspace(workspaceId: WorkspaceId): Promise<void> | void;
  onCloseWorkspace(workspaceId: WorkspaceId): Promise<void> | void;
}

export interface WorkspaceStripViewProps extends WorkspaceStripProps {
  getTabRef?: (workspaceId: WorkspaceId) => RefCallback<HTMLButtonElement>;
}

export function WorkspaceStrip(props: WorkspaceStripProps): JSX.Element {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeWorkspaceId = props.sidebarState.activeWorkspaceId;

  const getTabRef = useCallback((workspaceId: WorkspaceId): RefCallback<HTMLButtonElement> => {
    return (node) => {
      tabRefs.current[workspaceId] = node;
    };
  }, []);

  useEffect(() => {
    const activeTab = activeWorkspaceId ? tabRefs.current[activeWorkspaceId] : null;
    scrollWorkspaceTabIntoView(activeTab);
  }, [activeWorkspaceId]);

  return <WorkspaceStripView {...props} getTabRef={getTabRef} />;
}

export function WorkspaceStripView({
  sidebarState,
  badgeByWorkspaceId = {},
  getTabRef,
  onOpenFolder,
  onActivateWorkspace,
  onCloseWorkspace,
}: WorkspaceStripViewProps): JSX.Element {
  const workspaceCount = sidebarState.openWorkspaces.length;

  return (
    <section
      data-component="workspace-strip"
      className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar/80 text-sidebar-foreground"
    >
      <header className="shrink-0 px-2 py-2">
        <h2 className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-sidebar-foreground">
          Workspaces
        </h2>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {workspaceCount === 1 ? "1 open" : `${workspaceCount} open`}
        </p>
      </header>

      <div className="min-h-0 flex-1">
        {workspaceCount === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title="No workspace open"
            description="Open a folder to add a workspace."
          />
        ) : null}
        {workspaceCount === 0 ? (
          <ol
            role="tablist"
            aria-orientation="vertical"
            aria-label="Open workspaces"
            className="sr-only"
          />
        ) : (
          <ScrollArea className="h-full px-2" data-workspace-strip-scroll-area="true">
            <ol
              role="tablist"
              aria-orientation="vertical"
              aria-label="Open workspaces"
              className="flex min-w-0 flex-col gap-1 py-2"
            >
              {sidebarState.openWorkspaces.map((workspace, index) => {
                const isActive = workspace.id === sidebarState.activeWorkspaceId;
                const badge = badgeByWorkspaceId[workspace.id];
                const tabId = workspaceTabId(workspace.id);
                const pathDescriptionId = `${tabId}-path`;
                const Icon = isActive ? FolderOpen : Folder;
                const shortcutLabel = index < 3 ? `⌘${index + 1}` : null;
                const workspaceAriaLabel = badge
                  ? `${workspace.displayName}: ${badgeStateLabel(badge.state)}`
                  : workspace.displayName;

                return (
                  <li key={workspace.id} className="min-w-0">
                    <div
                      data-workspace-row="true"
                      data-active={isActive ? "true" : "false"}
                      className={cn(
                        "group flex h-8 min-w-0 items-center rounded-md transition-colors hover:bg-accent/70",
                        isActive && "bg-accent ring-1 ring-primary/30",
                      )}
                    >
                      <button
                        ref={getTabRef?.(workspace.id)}
                        type="button"
                        id={tabId}
                        role="tab"
                        aria-selected={isActive}
                        aria-describedby={pathDescriptionId}
                        aria-label={workspaceAriaLabel}
                        title={workspace.absolutePath}
                        data-action="activate-workspace"
                        data-workspace-id={workspace.id}
                        data-active={isActive ? "true" : "false"}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => {
                          void onActivateWorkspace(workspace.id);
                        }}
                      >
                        <Icon
                          aria-hidden="true"
                          data-workspace-icon={isActive ? "folder-open" : "folder"}
                          className="size-4 shrink-0 text-muted-foreground"
                          strokeWidth={1.75}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm leading-8">
                          {workspace.displayName}
                        </span>
                        {shortcutLabel ? (
                          <kbd
                            aria-hidden="true"
                            data-workspace-shortcut={shortcutLabel}
                            className="shrink-0 font-mono text-[10px] leading-none text-muted-foreground"
                          >
                            {shortcutLabel}
                          </kbd>
                        ) : null}
                        <WorkspaceStatusDot badge={badge} />
                        <span id={pathDescriptionId} className="sr-only">
                          {workspace.absolutePath}
                        </span>
                      </button>
                      <Button
                        type="button"
                        data-action="close-workspace"
                        data-workspace-id={workspace.id}
                        aria-label={`Close ${workspace.displayName}`}
                        variant="ghost"
                        size="icon-xs"
                        className="mr-1 size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                        onClick={() => {
                          void onCloseWorkspace(workspace.id);
                        }}
                      >
                        <X aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </ScrollArea>
        )}
      </div>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <Button
          type="button"
          data-action="open-folder"
          variant="outline"
          size="sm"
          className="h-8 w-full justify-between px-2 text-xs"
          onClick={() => {
            void onOpenFolder();
          }}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="truncate">Open Folder</span>
          </span>
          <kbd className="shrink-0 font-mono text-[10px] text-muted-foreground">⌘O</kbd>
        </Button>
      </div>
    </section>
  );
}

export function workspaceTabId(workspaceId: WorkspaceId): string {
  return `workspace-tab-${safeDomIdSegment(workspaceId)}`;
}

export function scrollWorkspaceTabIntoView(
  element: Pick<HTMLElement, "scrollIntoView"> | null,
): void {
  element?.scrollIntoView({ block: "nearest" });
}

function WorkspaceStatusDot({ badge }: { badge?: HarnessWorkspaceBadge }): JSX.Element {
  return (
    <>
      <span
        data-harness-badge-state={badge?.state ?? "idle"}
        className={cn(
          "block size-2 shrink-0 rounded-full",
          !badge && "bg-transparent",
          badge?.state === "running" && "bg-status-running",
          badge?.state === "awaiting-approval" && "bg-status-attention",
          badge?.state === "error" && "bg-destructive",
        )}
        aria-hidden="true"
      />
      {badge ? <span className="sr-only">{badgeStateLabel(badge.state)}</span> : null}
    </>
  );
}

function badgeStateLabel(state: HarnessWorkspaceBadge["state"]): string {
  switch (state) {
    case "running":
      return "Agent running";
    case "awaiting-approval":
      return "Awaiting terminal approval";
    case "error":
      return "Harness error";
  }
}

function safeDomIdSegment(value: string): string {
  return Array.from(value)
    .map((character) => {
      if (/^[A-Za-z0-9_-]$/.test(character)) {
        return character;
      }

      return `-${character.codePointAt(0)?.toString(16) ?? "0"}-`;
    })
    .join("");
}
