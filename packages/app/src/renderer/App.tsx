import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useStore } from "zustand";
import { Eye, Folder, GitCompare, History, Wrench } from "lucide-react";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import { ActivityBar } from "./components/ActivityBar";
import { CommandPalette } from "./components/CommandPalette";
import { EmptyState } from "./components/EmptyState";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { ScrollArea } from "./components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  getKeychordFromKeyboardEvent,
  keyboardRegistryStore,
  normalizeKeychord,
  shouldAllowSingleKeyInput,
} from "./stores/keyboard-registry";
import { createWorkspaceStore, type WorkspaceStore } from "./stores/workspace-store";
import { activateWorkspaceSlot, switchWorkspaceCycle } from "./workspace-switching-commands";

const WORKSPACE_PANEL_STORAGE_KEY = "nx.layout.workspacePanel";
const SHARED_PANEL_STORAGE_KEY = "nx.layout.sharedPanel";
const WORKSPACE_PANEL_DEFAULT_SIZE = 17;
const WORKSPACE_PANEL_MIN_SIZE = 12;
const WORKSPACE_PANEL_MAX_SIZE = 28;
const SHARED_PANEL_DEFAULT_SIZE = 20;
const SHARED_PANEL_MIN_SIZE = 16;
const SHARED_PANEL_MAX_SIZE = 32;
const RESIZE_KEYBOARD_STEP_PX = 16;

interface StoredPanelState {
  collapsed: boolean;
  size: number;
}

export default function App(): JSX.Element {
  const workspaceStore = useWorkspaceStore();
  const workspacePanelRef = useRef<PanelImperativeHandle | null>(null);
  const sharedPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [workspacePanelState, setWorkspacePanelState] = useState(() =>
    readStoredPanelState(WORKSPACE_PANEL_STORAGE_KEY, WORKSPACE_PANEL_DEFAULT_SIZE),
  );
  const [sharedPanelState, setSharedPanelState] = useState(() =>
    readStoredPanelState(SHARED_PANEL_STORAGE_KEY, SHARED_PANEL_DEFAULT_SIZE),
  );

  const sidebarState = useStore(workspaceStore, (state) => state.sidebarState);
  const refreshSidebarState = useStore(workspaceStore, (state) => state.refreshSidebarState);
  const applySidebarState = useStore(workspaceStore, (state) => state.applySidebarState);
  const openFolder = useStore(workspaceStore, (state) => state.openFolder);
  const activateWorkspace = useStore(workspaceStore, (state) => state.activateWorkspace);
  const closeWorkspace = useStore(workspaceStore, (state) => state.closeWorkspace);

  useEffect(() => {
    void refreshSidebarState().catch((error) => {
      console.error("Workspace sidebar: failed to load sidebar state.", error);
    });
  }, [refreshSidebarState]);

  useEffect(() => {
    const subscription = window.nexusWorkspace.onSidebarStateChanged((nextState) => {
      applySidebarState(nextState);
    });

    return () => {
      subscription.dispose();
    };
  }, [applySidebarState]);

  const persistWorkspacePanelState = useCallback((nextState: StoredPanelState) => {
    persistPanelState(WORKSPACE_PANEL_STORAGE_KEY, nextState);
    setWorkspacePanelState(nextState);
  }, []);

  const persistSharedPanelState = useCallback((nextState: StoredPanelState) => {
    persistPanelState(SHARED_PANEL_STORAGE_KEY, nextState);
    setSharedPanelState(nextState);
  }, []);

  useEffect(() => {
    registerAppCommands({
      closeWorkspace,
      openFolder,
      setCommandPaletteOpen,
      sharedPanelRef,
      workspacePanelRef,
      workspaceStore,
    });
  }, [closeWorkspace, openFolder, workspaceStore]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (shouldAllowSingleKeyInput(event)) {
        return;
      }

      const keychord = normalizeKeychord(getKeychordFromKeyboardEvent(event));
      const commandId = keyboardRegistryStore.getState().bindings[keychord];

      if (!commandId) {
        return;
      }

      event.preventDefault();
      void keyboardRegistryStore.getState().executeCommand(commandId);
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const handleWorkspaceResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    resizePanelByPixels(workspacePanelRef.current, event.key === "ArrowLeft" ? -RESIZE_KEYBOARD_STEP_PX : RESIZE_KEYBOARD_STEP_PX);
  }, []);

  const handleSharedResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    resizePanelByPixels(sharedPanelRef.current, event.key === "ArrowLeft" ? RESIZE_KEYBOARD_STEP_PX : -RESIZE_KEYBOARD_STEP_PX);
  }, []);

  return (
    <div className="flex h-full bg-background text-foreground">
      <ActivityBar />
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />

      <ResizablePanelGroup direction="horizontal" className="min-w-0 flex-1">
        <ResizablePanel
          panelRef={workspacePanelRef}
          id="workspace-panel"
          order={1}
          collapsible
          collapsedSize={0}
          defaultSize={workspacePanelState.collapsed ? 0 : workspacePanelState.size}
          minSize={WORKSPACE_PANEL_MIN_SIZE}
          maxSize={WORKSPACE_PANEL_MAX_SIZE}
          onCollapse={() => persistWorkspacePanelState({ ...workspacePanelState, collapsed: true })}
          onExpand={() => persistWorkspacePanelState({ ...workspacePanelState, collapsed: false })}
          onResize={(size) => persistWorkspacePanelState({ collapsed: size === 0, size: size > 0 ? size : workspacePanelState.size })}
          className="min-h-0"
        >
          <ScrollArea className="h-full border-r border-border bg-sidebar/70">
            <aside className="flex min-h-full flex-col gap-3 p-3">
              <WorkspaceSidebar
                sidebarState={sidebarState}
                onOpenFolder={() => runSidebarMutation(openFolder)}
                onActivateWorkspace={(workspaceId) =>
                  runSidebarMutation(() => activateWorkspace(workspaceId))
                }
                onCloseWorkspace={(workspaceId) =>
                  runSidebarMutation(() => closeWorkspace(workspaceId))
                }
              />

              <div className="h-48 rounded-md border border-border bg-card">
                <EmptyState
                  icon={Folder}
                  title="Files appear here"
                  description="Open a workspace folder."
                />
              </div>
            </aside>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle
          withHandle
          role="separator"
          aria-valuemin={WORKSPACE_PANEL_MIN_SIZE}
          aria-valuemax={WORKSPACE_PANEL_MAX_SIZE}
          aria-valuenow={Math.round(workspacePanelState.collapsed ? 0 : workspacePanelState.size)}
          className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
          onKeyDown={handleWorkspaceResizeKeyDown}
        />

        <ResizablePanel id="center-panel" order={2} minSize={20} className="min-h-0 min-w-0">
          <main className="flex h-full min-h-0 flex-col border-r border-border bg-background/80 p-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground">Center Terminal</h2>
            <div className="mt-3 min-h-0 flex-1 rounded-md border border-border bg-card p-3">
              <TerminalPane sidebarState={sidebarState} />
            </div>
          </main>
        </ResizablePanel>

        <ResizableHandle
          withHandle
          role="separator"
          aria-valuemin={SHARED_PANEL_MIN_SIZE}
          aria-valuemax={SHARED_PANEL_MAX_SIZE}
          aria-valuenow={Math.round(sharedPanelState.collapsed ? 0 : sharedPanelState.size)}
          className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
          onKeyDown={handleSharedResizeKeyDown}
        />

        <ResizablePanel
          panelRef={sharedPanelRef}
          id="shared-panel"
          order={3}
          collapsible
          collapsedSize={0}
          defaultSize={sharedPanelState.collapsed ? 0 : sharedPanelState.size}
          minSize={SHARED_PANEL_MIN_SIZE}
          maxSize={SHARED_PANEL_MAX_SIZE}
          onCollapse={() => persistSharedPanelState({ ...sharedPanelState, collapsed: true })}
          onExpand={() => persistSharedPanelState({ ...sharedPanelState, collapsed: false })}
          onResize={(size) => persistSharedPanelState({ collapsed: size === 0, size: size > 0 ? size : sharedPanelState.size })}
          className="min-h-0"
        >
          <ScrollArea className="h-full bg-card/60">
            <aside className="min-h-full p-4">
              <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground">Right Shared Panel</h2>
              <Tabs className="mt-3" defaultValue="tool">
                <TabsList>
                  <TabsTrigger value="tool">Tool</TabsTrigger>
                  <TabsTrigger value="session">Session</TabsTrigger>
                  <TabsTrigger value="diff">Diff</TabsTrigger>
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                </TabsList>
                <TabsContent value="tool" className="h-48 rounded-md border border-border bg-card">
                  <EmptyState
                    icon={Wrench}
                    title="No tool calls yet"
                    description="Agent tool invocations will appear here."
                  />
                </TabsContent>
                <TabsContent value="session" className="h-48 rounded-md border border-border bg-card">
                  <EmptyState
                    icon={History}
                    title="No session history"
                    description="Session entries will appear here."
                  />
                </TabsContent>
                <TabsContent value="diff" className="h-48 rounded-md border border-border bg-card">
                  <EmptyState
                    icon={GitCompare}
                    title="No changes to review"
                    description="Pending changes will appear here."
                  />
                </TabsContent>
                <TabsContent value="preview" className="h-48 rounded-md border border-border bg-card">
                  <EmptyState
                    icon={Eye}
                    title="Preview unavailable"
                    description="Markdown or localhost preview will appear here."
                  />
                </TabsContent>
              </Tabs>
            </aside>
          </ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function readStoredPanelState(storageKey: string, fallbackSize: number): StoredPanelState {
  const fallbackState = { collapsed: false, size: fallbackSize };

  try {
    const rawValue = window.localStorage.getItem(storageKey);

    if (!rawValue) {
      return fallbackState;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<StoredPanelState>;
    const size = typeof parsedValue.size === "number" ? parsedValue.size : fallbackSize;

    return {
      collapsed: parsedValue.collapsed === true,
      size,
    };
  } catch {
    return fallbackState;
  }
}

function persistPanelState(storageKey: string, state: StoredPanelState): void {
  window.localStorage.setItem(storageKey, JSON.stringify(state));
}

function togglePanel(panel: PanelImperativeHandle | null): void {
  if (!panel) {
    return;
  }

  if (panel.isCollapsed()) {
    panel.expand();
    return;
  }

  panel.collapse();
}

function resizePanelByPixels(panel: PanelImperativeHandle | null, deltaPx: number): void {
  if (!panel || panel.isCollapsed()) {
    return;
  }

  const currentSize = panel.getSize();
  panel.resize(`${currentSize.inPixels + deltaPx}px`);
}

function registerAppCommands({
  closeWorkspace,
  openFolder,
  setCommandPaletteOpen,
  sharedPanelRef,
  workspacePanelRef,
  workspaceStore,
}: {
  closeWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
  openFolder: () => Promise<void>;
  setCommandPaletteOpen: (open: boolean) => void;
  sharedPanelRef: RefObject<PanelImperativeHandle | null>;
  workspacePanelRef: RefObject<PanelImperativeHandle | null>;
  workspaceStore: WorkspaceStore;
}): void {
  const registry = keyboardRegistryStore.getState();
  const workspaceSwitchingModel = {
    getSidebarState: () => workspaceStore.getState().sidebarState,
    activateWorkspace: async (workspaceId: WorkspaceId) => {
      await workspaceStore.getState().activateWorkspace(workspaceId);
      return workspaceStore.getState().sidebarState;
    },
  };

  const registerCommand = registry.registerCommand;
  const registerBinding = registry.registerBinding;

  registerCommand({
    group: "Workspace",
    id: "workspace.switch.1",
    run: () => activateWorkspaceSlot(workspaceSwitchingModel, 1),
    title: "Switch to Workspace 1",
  });
  registerCommand({
    group: "Workspace",
    id: "workspace.switch.2",
    run: () => activateWorkspaceSlot(workspaceSwitchingModel, 2),
    title: "Switch to Workspace 2",
  });
  registerCommand({
    group: "Workspace",
    id: "workspace.switch.3",
    run: () => activateWorkspaceSlot(workspaceSwitchingModel, 3),
    title: "Switch to Workspace 3",
  });
  registerCommand({
    group: "Workspace",
    id: "workspace.openFolder",
    run: () => runSidebarMutation(openFolder),
    title: "Open Folder",
  });
  registerCommand({
    group: "Workspace",
    id: "workspace.close",
    run: async () => {
      const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;

      if (activeWorkspaceId) {
        await runSidebarMutation(() => closeWorkspace(activeWorkspaceId));
      }
    },
    title: "Close Workspace",
  });
  registerCommand({
    group: "Workspace",
    hidden: true,
    id: "workspace.previous",
    run: () => switchWorkspaceCycle(workspaceSwitchingModel, "previous"),
    title: "Previous Workspace",
  });
  registerCommand({
    group: "Workspace",
    hidden: true,
    id: "workspace.next",
    run: () => switchWorkspaceCycle(workspaceSwitchingModel, "next"),
    title: "Next Workspace",
  });
  registerCommand({
    group: "View",
    id: "view.toggleSidebar",
    run: () => togglePanel(workspacePanelRef.current),
    title: "Toggle Sidebar",
  });
  registerCommand({
    group: "View",
    id: "view.toggleSharedPanel",
    run: () => togglePanel(sharedPanelRef.current),
    title: "Toggle Shared Panel",
  });
  registerCommand({
    group: "View",
    id: "view.focusTerminal",
    run: focusTerminal,
    title: "Focus Terminal",
  });
  registerCommand({
    group: "Terminal",
    id: "terminal.newTab",
    run: clickNewTerminalTab,
    title: "New Terminal Tab",
  });
  registerCommand({
    group: "Terminal",
    id: "terminal.closeTab",
    run: clickCloseActiveTerminalTab,
    title: "Close Terminal Tab",
  });
  registerCommand({
    group: "Terminal",
    hidden: true,
    id: "terminal.previousTab",
    run: () => clickAdjacentTerminalTab("previous"),
    title: "Previous Terminal Tab",
  });
  registerCommand({
    group: "Terminal",
    hidden: true,
    id: "terminal.nextTab",
    run: () => clickAdjacentTerminalTab("next"),
    title: "Next Terminal Tab",
  });
  registerCommand({
    group: "App",
    id: "app.reload",
    run: () => window.location.reload(),
    title: "Reload App",
  });
  registerCommand({
    group: "App",
    id: "app.preferences",
    run: () => console.log("Preferences command selected."),
    title: "Preferences",
  });
  registerCommand({
    group: "App",
    hidden: true,
    id: "commandPalette.open",
    run: () => setCommandPaletteOpen(true),
    title: "Open Command Palette",
  });
  registerCommand({
    group: "App",
    hidden: true,
    id: "commandPalette.close",
    run: () => setCommandPaletteOpen(false),
    title: "Close Command Palette",
  });

  registerBinding("Cmd+1", "workspace.switch.1");
  registerBinding("Cmd+2", "workspace.switch.2");
  registerBinding("Cmd+3", "workspace.switch.3");
  registerBinding("Cmd+O", "workspace.openFolder");
  registerBinding("Cmd+B", "view.toggleSidebar");
  registerBinding("Cmd+J", "view.toggleSharedPanel");
  registerBinding("Ctrl+`", "view.focusTerminal");
  registerBinding("Cmd+T", "terminal.newTab");
  registerBinding("Cmd+W", "terminal.closeTab");
  registerBinding("Cmd+Shift+P", "commandPalette.open");
  registerBinding("Cmd+P", "commandPalette.open");
  registerBinding("Escape", "commandPalette.close");
  registerBinding("Cmd+Shift+[", "terminal.previousTab");
  registerBinding("Cmd+Shift+]", "terminal.nextTab");
}

function focusTerminal(): void {
  const terminalTextarea = document.querySelector<HTMLElement>(".xterm-helper-textarea");

  if (terminalTextarea) {
    terminalTextarea.focus();
    return;
  }

  document.querySelector<HTMLElement>('[data-slot="terminal-pane-host"]')?.focus();
}

function clickNewTerminalTab(): void {
  document.querySelector<HTMLButtonElement>('button[data-action="new-tab"]:not(:disabled)')?.click();
}

function clickCloseActiveTerminalTab(): void {
  const activeTab = document.querySelector<HTMLElement>('button[data-action="activate-tab"][data-active="true"]');
  activeTab?.parentElement?.querySelector<HTMLButtonElement>('button[data-action="close-tab"]')?.click();
}

function clickAdjacentTerminalTab(direction: "next" | "previous"): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-action="activate-tab"]'));

  if (tabs.length === 0) {
    return;
  }

  const activeIndex = tabs.findIndex((tab) => tab.dataset.active === "true");
  const currentIndex = activeIndex >= 0 ? activeIndex : 0;
  const delta = direction === "next" ? 1 : -1;
  const targetIndex = (currentIndex + delta + tabs.length) % tabs.length;
  tabs[targetIndex]?.click();
}

function useWorkspaceStore(): WorkspaceStore {
  const workspaceStoreRef = useRef<WorkspaceStore | null>(null);

  if (!workspaceStoreRef.current) {
    workspaceStoreRef.current = createWorkspaceStore(window.nexusWorkspace);
  }

  return workspaceStoreRef.current;
}

async function runSidebarMutation(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error("Workspace sidebar: failed to apply workspace mutation.", error);
  }
}
