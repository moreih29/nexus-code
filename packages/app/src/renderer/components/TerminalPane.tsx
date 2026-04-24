import { useCallback, useEffect, useRef, useState } from "react";

import type { TerminalTabId } from "../../../../shared/src/contracts/terminal-tab";
import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace-shell";
import { createShellTerminalSessionAdapter } from "../adapters/shell-terminal-session-adapter";
import { PreloadTerminalBridgeTransport } from "../adapters/preload-terminal-bridge-transport";
import { cn } from "../lib/utils";
import {
  ShellTerminalTabs,
  type ShellTerminalClipboard,
  type ShellTerminalTabsSnapshot,
} from "../shell-terminal-tab";
import { TerminalBridge } from "../terminal-bridge";

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
    <section data-component="terminal-pane" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <ol className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {activeWorkspace?.tabs.map((tab) => (
            <li key={tab.tabId} className="flex flex-shrink-0 items-center gap-1">
              <button
                type="button"
                data-action="activate-tab"
                data-tab-id={tab.tabId}
                data-active={tab.isActive ? "true" : "false"}
                className={cn(
                  "rounded-md border px-3 py-1 text-xs font-medium",
                  tab.isActive
                    ? "border-sky-600 bg-sky-500/20 text-sky-100"
                    : "border-slate-700 bg-slate-900/70 text-slate-300 hover:border-slate-500",
                )}
                onClick={() => {
                  handleActivateTab(tab.tabId);
                }}
              >
                {tab.title}
              </button>
              <button
                type="button"
                data-action="close-tab"
                data-tab-id={tab.tabId}
                aria-label={`Close ${tab.title}`}
                className="rounded border border-transparent px-1 py-1 text-xs text-slate-400 hover:border-slate-700 hover:text-slate-200"
                onClick={() => {
                  handleCloseTab(tab.tabId);
                }}
              >
                ×
              </button>
            </li>
          ))}

          {activeWorkspace && activeWorkspace.tabs.length === 0 ? (
            <li className="rounded-md border border-dashed border-slate-700 px-2 py-1 text-xs text-slate-500">
              No terminal tabs
            </li>
          ) : null}
        </ol>

        <button
          type="button"
          data-action="new-tab"
          data-workspace-id={activeWorkspaceId ?? ""}
          className="rounded-md border border-slate-700 px-2 py-1 text-sm font-semibold text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!activeWorkspaceId}
          onClick={handleCreateTab}
        >
          +
        </button>
      </header>

      <div className="relative mt-2 min-h-0 flex-1 rounded-md border border-emerald-700/40 bg-black/50 p-2">
        <div
          ref={terminalHostRef}
          data-slot="terminal-pane-host"
          className="h-full w-full"
        />

        {!activeWorkspaceId ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-500">
            Open a workspace to start a terminal.
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
