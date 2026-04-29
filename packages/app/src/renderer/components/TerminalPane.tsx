import { useCallback, useEffect, useMemo, useRef, type DragEvent } from "react";
import { useStore } from "zustand";
import { Plus, SquareTerminal, X } from "lucide-react";

import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace/workspace-shell";
import type { TerminalServiceStore, TerminalTab, TerminalTabId } from "../services/terminal-service";
import {
  dataTransferHasTerminalTabDragData,
  readTerminalTabDragDataTransfer,
  writeTerminalTabDragDataTransfer,
  type TerminalTabDragData,
} from "./file-tree-dnd/drag-and-drop";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { EmptyState } from "./EmptyState";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "../lib/utils";

export interface TerminalPaneProps {
  sidebarState: WorkspaceSidebarState;
  terminalService: TerminalServiceStore;
  detachedTerminalIds?: readonly TerminalTabId[];
  onMoveTerminalToEditorArea?(sessionId: TerminalTabId): void;
  onDropTerminalTab?(payload: TerminalTabDragData): boolean | void;
}

interface TerminalSessionHostProps {
  active: boolean;
  sessionId: TerminalTabId;
  terminalService: TerminalServiceStore;
}

export function TerminalPane({
  sidebarState,
  terminalService,
  detachedTerminalIds = [],
  onMoveTerminalToEditorArea,
  onDropTerminalTab,
}: TerminalPaneProps): JSX.Element {
  const tabs = useStore(terminalService, (state) => state.tabs);
  const activeTabIdByWorkspaceId = useStore(terminalService, (state) => state.activeTabIdByWorkspaceId);
  const activeWorkspaceId = sidebarState.activeWorkspaceId;
  const detachedTerminalIdSet = useMemo(() => new Set(detachedTerminalIds), [detachedTerminalIds]);
  const activeWorkspaceTabs = useMemo(
    () => tabs.filter((tab) => tab.workspaceId === activeWorkspaceId && !detachedTerminalIdSet.has(tab.id)),
    [activeWorkspaceId, detachedTerminalIdSet, tabs],
  );
  const activeTabId = resolveActiveTabId(
    activeWorkspaceTabs,
    activeWorkspaceId ? activeTabIdByWorkspaceId[activeWorkspaceId] : null,
  );

  const handleCreateTab = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }

    void terminalService.getState().requestNewTab(activeWorkspaceId).catch((error) => {
      console.error("TerminalPane: failed to create terminal tab.", error);
    });
  }, [activeWorkspaceId, terminalService]);

  const handleActivateTab = useCallback(
    (tabId: TerminalTabId) => {
      terminalService.getState().setActiveTab(tabId);
    },
    [terminalService],
  );

  const handleCloseTab = useCallback(
    (tabId: TerminalTabId) => {
      terminalService.getState().closeTab(tabId);
    },
    [terminalService],
  );
  const handleTerminalTabDropTargetDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    const payload = readTerminalTabDragDataTransfer(event.dataTransfer);
    if (!isEditorGroupTerminalTabDropPayload(payload) && !(
      payload === null && dataTransferHasTerminalTabDragData(event.dataTransfer)
    )) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
  }, []);
  const handleTerminalTabDropTargetDrop = useCallback((event: DragEvent<HTMLElement>) => {
    const payload = readTerminalTabDragDataTransfer(event.dataTransfer);
    if (!isEditorGroupTerminalTabDropPayload(payload)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    applyEditorGroupTerminalTabDrop(payload, terminalService, onDropTerminalTab);
  }, [onDropTerminalTab, terminalService]);

  return (
    <section data-component="terminal-pane" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border pb-2">
        <Tabs
          value={activeTabId ?? undefined}
          onValueChange={(tabId) => {
            handleActivateTab(tabId as TerminalTabId);
          }}
          className="min-w-0 flex-1 gap-0"
        >
          <TabsList
            variant="line"
            data-terminal-tab-drop-zone="bottom-panel"
            onDragEnter={handleTerminalTabDropTargetDragOver}
            onDragOver={handleTerminalTabDropTargetDragOver}
            onDrop={handleTerminalTabDropTargetDrop}
            className="h-9 max-w-full justify-start overflow-x-auto rounded-none p-0"
          >
            {activeWorkspaceTabs.map((tab) => (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger asChild>
                  <div className="flex h-9 flex-shrink-0 items-center gap-1">
                    <TabsTrigger
                      value={tab.id}
                      data-action="activate-tab"
                      data-tab-id={tab.id}
                      data-terminal-tab-drag-source="bottom-panel"
                      data-active={activeTabId === tab.id ? "true" : "false"}
                      draggable={Boolean(tab.workspaceId)}
                      className={cn(
                        "h-9 rounded-md border border-transparent px-3 text-base font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=active]:bg-accent data-[state=active]:text-accent-foreground",
                        "after:hidden dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-accent dark:data-[state=active]:text-accent-foreground",
                      )}
                      onDragStart={(event) => handleBottomPanelTerminalTabDragStart(event, tab)}
                    >
                      {tab.title}
                    </TabsTrigger>
                    <Button
                      type="button"
                      data-action="close-tab"
                      data-tab-id={tab.id}
                      aria-label={`Close ${tab.title}`}
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        handleCloseTab(tab.id);
                      }}
                    >
                      <X size={14} strokeWidth={1.75} />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent data-terminal-tab-context-menu="true" aria-label={`${tab.title} terminal tab menu`}>
                  <ContextMenuItem
                    data-menu-item-id="move-to-editor-area"
                    disabled={!onMoveTerminalToEditorArea}
                    onSelect={() => {
                      onMoveTerminalToEditorArea?.(tab.id);
                    }}
                  >
                    <SquareTerminal aria-hidden="true" className="text-muted-foreground" />
                    <span>Move to Editor Area</span>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    data-menu-item-id="close"
                    onSelect={() => {
                      handleCloseTab(tab.id);
                    }}
                  >
                    <X aria-hidden="true" className="text-muted-foreground" />
                    <span>Close</span>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}

          </TabsList>
        </Tabs>

        <Button
          type="button"
          data-action="new-tab"
          data-workspace-id={activeWorkspaceId ?? ""}
          variant="outline"
          size="icon-sm"
          className="h-9 w-9"
          disabled={!activeWorkspaceId}
          onClick={handleCreateTab}
        >
          <Plus size={14} strokeWidth={1.75} />
        </Button>
      </header>

      <div className="relative mt-2 min-h-0 flex-1 overflow-hidden bg-background" data-slot="terminal-pane-host">
        {activeWorkspaceTabs.map((tab) => (
          <TerminalSessionHost
            key={tab.id}
            sessionId={tab.id}
            active={activeTabId === tab.id}
            terminalService={terminalService}
          />
        ))}

        {!activeWorkspaceId || activeWorkspaceTabs.length === 0 ? (
          <div className="absolute inset-0 bg-background">
            <EmptyState
              icon={SquareTerminal}
              title="No terminal session"
              description="Create a terminal tab for this workspace."
              action={{ label: "New Terminal", shortcut: "⌘T", onClick: handleCreateTab }}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TerminalSessionHost({ active, sessionId, terminalService }: TerminalSessionHostProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    return terminalService.getState().attachToHost(sessionId, host, { focus: active });
  }, [active, sessionId, terminalService]);

  useEffect(() => {
    if (active) {
      terminalService.getState().focusSession(sessionId);
    }
  }, [active, sessionId, terminalService]);

  return (
    <div
      ref={hostRef}
      data-terminal-tab-id={sessionId}
      aria-hidden={active ? "false" : "true"}
      className={cn("absolute inset-0 h-full min-h-0 w-full overflow-hidden", active ? "block" : "hidden")}
    />
  );
}

function resolveActiveTabId(
  tabs: readonly TerminalTab[],
  requestedActiveTabId: TerminalTabId | null | undefined,
): TerminalTabId | null {
  if (requestedActiveTabId && tabs.some((tab) => tab.id === requestedActiveTabId)) {
    return requestedActiveTabId;
  }

  return tabs.at(-1)?.id ?? null;
}

export function isEditorGroupTerminalTabDropPayload(
  payload: TerminalTabDragData | null,
): payload is TerminalTabDragData {
  return payload?.source === "editor-group" || (payload?.source === undefined && Boolean(payload?.sourceGroupId));
}

export function applyEditorGroupTerminalTabDrop(
  payload: TerminalTabDragData | null,
  terminalService: TerminalServiceStore,
  onDropTerminalTab?: (payload: TerminalTabDragData) => boolean | void,
): boolean {
  if (!isEditorGroupTerminalTabDropPayload(payload)) {
    return false;
  }

  const handled = onDropTerminalTab?.(payload);
  if (handled === false) {
    return false;
  }

  terminalService.getState().setActiveTab(payload.tabId);
  return true;
}

function handleBottomPanelTerminalTabDragStart(
  event: DragEvent<HTMLElement>,
  tab: TerminalTab,
): void {
  if (!tab.workspaceId) {
    event.preventDefault();
    return;
  }

  writeTerminalTabDragDataTransfer(event.dataTransfer, {
    type: "terminal-tab",
    workspaceId: tab.workspaceId,
    tabId: tab.id,
    source: "bottom-panel",
  });
}
