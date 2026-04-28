import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";

import type { TerminalTabId } from "../../../../shared/src/contracts/terminal/terminal-tab";
import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace/workspace-shell";
import { createShellTerminalSessionAdapter } from "../adapters/shell-terminal-session-adapter";
import { PreloadTerminalBridgeTransport } from "../adapters/preload-terminal-bridge-transport";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "../lib/utils";
import {
  ShellTerminalTabs,
  type ShellTerminalClipboard,
  type ShellTerminalTabsSnapshot,
} from "../terminal/shell-terminal-tab";
import { TerminalBridge } from "../terminal/terminal-bridge";
import { installTerminalHostResizeFit } from "../terminal/terminal-resize-fit";

export interface TerminalPaneProps {
  sidebarState: WorkspaceSidebarState;
}

const EMPTY_SNAPSHOT: ShellTerminalTabsSnapshot = {
  workspaceOrder: [],
  activeWorkspaceId: null,
  workspaces: [],
  search: {
    isOpen: false,
    query: "",
    noMoreMatches: false,
    statusMessage: null,
  },
};

export function TerminalPane({ sidebarState }: TerminalPaneProps): JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalTabsRef = useRef<ShellTerminalTabs | null>(null);
  const operationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const disposedRef = useRef(false);

  const [snapshot, setSnapshot] = useState<ShellTerminalTabsSnapshot>(EMPTY_SNAPSHOT);

  const refreshSnapshot = useCallback(() => {
    if (disposedRef.current) {
      return;
    }

    const terminalTabs = terminalTabsRef.current;
    if (!terminalTabs) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }

    setSnapshot(terminalTabs.getSnapshot());
  }, []);

  const enqueueTabsOperation = useCallback(
    (operationName: string, operation: (terminalTabs: ShellTerminalTabs) => Promise<void> | void) => {
      operationQueueRef.current = operationQueueRef.current
        .catch(() => {
          // keep processing queued operations after failures.
        })
        .then(async () => {
          if (disposedRef.current) {
            return;
          }

          const terminalTabs = terminalTabsRef.current;
          if (!terminalTabs) {
            return;
          }

          try {
            await operation(terminalTabs);
          } catch (error) {
            console.error(`TerminalPane: failed to ${operationName}.`, error);
          }

          refreshSnapshot();
        });
    },
    [refreshSnapshot],
  );

  useEffect(() => {
    const terminalHost = terminalHostRef.current;
    if (!terminalHost) {
      return;
    }

    disposedRef.current = false;

    const bridge = new TerminalBridge(new PreloadTerminalBridgeTransport());
    const terminalTabs = new ShellTerminalTabs({
      terminalPaneHost: terminalHost,
      session: createShellTerminalSessionAdapter(bridge),
      clipboard: createClipboardAdapter(),
    });

    terminalTabsRef.current = terminalTabs;
    const resizeFitSubscription = installTerminalHostResizeFit({
      host: terminalHost,
      getTerminalTabs: () => terminalTabsRef.current,
    });
    refreshSnapshot();

    const stdoutSubscription = bridge.onStdout((stdoutChunk) => {
      terminalTabsRef.current?.writeToTab(stdoutChunk.tabId, stdoutChunk.data);
    });

    const exitedSubscription = bridge.onExited((exitEvent) => {
      enqueueTabsOperation("cleanup exited tab", (tabs) => {
        tabs.handleTabExited(exitEvent.tabId);
      });
    });

    return () => {
      disposedRef.current = true;

      stdoutSubscription.dispose();
      exitedSubscription.dispose();

      resizeFitSubscription.dispose();
      terminalTabs.dispose();
      bridge.dispose();

      terminalTabsRef.current = null;
      operationQueueRef.current = Promise.resolve();
      setSnapshot(EMPTY_SNAPSHOT);
    };
  }, [enqueueTabsOperation, refreshSnapshot]);

  useEffect(() => {
    enqueueTabsOperation("sync workspace sidebar state", async (terminalTabs) => {
      await terminalTabs.syncSidebarState(sidebarState);
    });
  }, [enqueueTabsOperation, sidebarState]);

  const activeWorkspace =
    snapshot.workspaces.find((workspace) => workspace.workspaceId === sidebarState.activeWorkspaceId) ??
    snapshot.workspaces.find((workspace) => workspace.isActiveWorkspace) ??
    null;

  const activeWorkspaceId = sidebarState.activeWorkspaceId;
  const activeTabId = activeWorkspace?.tabs.find((tab) => tab.isActive)?.tabId;

  const handleCreateTab = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }

    enqueueTabsOperation("create terminal tab", async (terminalTabs) => {
      await terminalTabs.createTab(activeWorkspaceId, true);
    });
  }, [activeWorkspaceId, enqueueTabsOperation]);

  const handleActivateTab = useCallback(
    (tabId: TerminalTabId) => {
      enqueueTabsOperation("activate terminal tab", (terminalTabs) => {
        terminalTabs.activateTab(tabId);
      });
    },
    [enqueueTabsOperation],
  );

  const handleCloseTab = useCallback(
    (tabId: TerminalTabId) => {
      enqueueTabsOperation("close terminal tab", async (terminalTabs) => {
        await terminalTabs.closeTab(tabId);
      });
    },
    [enqueueTabsOperation],
  );

  return (
    <section data-component="terminal-pane" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border pb-2">
        <Tabs
          value={activeTabId}
          onValueChange={(tabId) => {
            handleActivateTab(tabId as TerminalTabId);
          }}
          className="min-w-0 flex-1 gap-0"
        >
          <TabsList variant="line" className="h-9 max-w-full justify-start overflow-x-auto rounded-none p-0">
            {activeWorkspace?.tabs.map((tab) => (
              <div key={tab.tabId} className="flex h-9 flex-shrink-0 items-center gap-1">
                <TabsTrigger
                  value={tab.tabId}
                  data-action="activate-tab"
                  data-tab-id={tab.tabId}
                  data-active={tab.isActive ? "true" : "false"}
                  className={cn(
                    "h-9 rounded-md border border-transparent px-3 text-base font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=active]:bg-accent data-[state=active]:text-accent-foreground",
                    "after:hidden dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-accent dark:data-[state=active]:text-accent-foreground",
                  )}
                >
                  {tab.title}
                </TabsTrigger>
                <Button
                  type="button"
                  data-action="close-tab"
                  data-tab-id={tab.tabId}
                  aria-label={`Close ${tab.title}`}
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    handleCloseTab(tab.tabId);
                  }}
                >
                  <X size={14} strokeWidth={1.75} />
                </Button>
              </div>
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

      <div className="relative mt-2 min-h-0 flex-1 overflow-hidden bg-background">
        <div
          ref={terminalHostRef}
          data-slot="terminal-pane-host"
          className="h-full min-h-0 w-full overflow-hidden"
        />

        {!activeWorkspaceId || !activeWorkspace || activeWorkspace.tabs.length === 0 ? (
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

function createClipboardAdapter(): ShellTerminalClipboard {
  const clipboardApi = globalThis.navigator?.clipboard;
  if (!clipboardApi) {
    return {
      async readText(): Promise<string> {
        return "";
      },
      async writeText(_value: string): Promise<void> {
        // no-op
      },
    };
  }

  return {
    async readText(): Promise<string> {
      try {
        return await clipboardApi.readText();
      } catch {
        return "";
      }
    },
    async writeText(value: string): Promise<void> {
      try {
        await clipboardApi.writeText(value);
      } catch {
        // no-op
      }
    },
  };
}
