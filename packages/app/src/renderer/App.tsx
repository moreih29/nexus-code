import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "zustand";
import { Eye, Folder, GitCompare, GripVertical, History, Wrench } from "lucide-react";

import type { WorkspaceId } from "../../../shared/src/contracts/workspace";
import { ActivityBar } from "./components/ActivityBar";
import { CommandPalette } from "./components/CommandPalette";
import { EmptyState } from "./components/EmptyState";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { ScrollArea } from "./components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  getKeychordFromKeyboardEvent,
  keyboardRegistryStore,
  normalizeKeychord,
  shouldAllowSingleKeyInput,
} from "./stores/keyboard-registry";
import { createHarnessBadgeStore, type HarnessBadgeStore } from "./stores/harnessBadgeStore";
import { createWorkspaceStore, type WorkspaceStore } from "./stores/workspace-store";
import { activateWorkspaceSlot, switchWorkspaceCycle } from "./workspace-switching-commands";

const WORKSPACE_PANEL_STORAGE_KEY = "nx.layout.workspacePanel";
const SHARED_PANEL_STORAGE_KEY = "nx.layout.sharedPanel";
const WORKSPACE_PANEL_DEFAULT_SIZE = 272;
const WORKSPACE_PANEL_MIN_SIZE = 192;
const WORKSPACE_PANEL_MAX_SIZE = 448;
const SHARED_PANEL_DEFAULT_SIZE = 320;
const SHARED_PANEL_MIN_SIZE = 256;
const SHARED_PANEL_MAX_SIZE = 512;
const RESIZE_KEYBOARD_STEP_PX = 16;

interface StoredPanelState {
  size: number;
}

interface ResizeDragState {
  pointerId: number;
  startClientX: number;
  startSize: number;
}

export default function App(): JSX.Element {
  const workspaceStore = useWorkspaceStore();
  const harnessBadgeStore = useHarnessBadgeStore();
  const workspacePanelRef = useRef<HTMLDivElement | null>(null);
  const sharedPanelRef = useRef<HTMLDivElement | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [workspaceVisible, setWorkspaceVisible] = useState(true);
  const [sharedVisible, setSharedVisible] = useState(true);
  const [draggingPanel, setDraggingPanel] = useState<"workspace" | "shared" | null>(null);
  const [workspacePanelState, setWorkspacePanelState] = useState(() =>
    readStoredPanelState(
      WORKSPACE_PANEL_STORAGE_KEY,
      WORKSPACE_PANEL_DEFAULT_SIZE,
      WORKSPACE_PANEL_MIN_SIZE,
      WORKSPACE_PANEL_MAX_SIZE,
    ),
  );
  const [sharedPanelState, setSharedPanelState] = useState(() =>
    readStoredPanelState(
      SHARED_PANEL_STORAGE_KEY,
      SHARED_PANEL_DEFAULT_SIZE,
      SHARED_PANEL_MIN_SIZE,
      SHARED_PANEL_MAX_SIZE,
    ),
  );
  const workspaceLatestSizeRef = useRef(workspacePanelState.size);
  const sharedLatestSizeRef = useRef(sharedPanelState.size);
  const workspaceResizeStartRef = useRef<ResizeDragState | null>(null);
  const sharedResizeStartRef = useRef<ResizeDragState | null>(null);

  const sidebarState = useStore(workspaceStore, (state) => state.sidebarState);
  const refreshSidebarState = useStore(workspaceStore, (state) => state.refreshSidebarState);
  const applySidebarState = useStore(workspaceStore, (state) => state.applySidebarState);
  const openFolder = useStore(workspaceStore, (state) => state.openFolder);
  const activateWorkspace = useStore(workspaceStore, (state) => state.activateWorkspace);
  const closeWorkspace = useStore(workspaceStore, (state) => state.closeWorkspace);
  const badgeByWorkspaceId = useStore(harnessBadgeStore, (state) => state.badgeByWorkspaceId);

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

  useEffect(() => {
    const harnessBadgeState = harnessBadgeStore.getState();
    harnessBadgeState.startObserverSubscription();

    return () => {
      harnessBadgeStore.getState().stopObserverSubscription();
    };
  }, [harnessBadgeStore]);

  const toggleWorkspacePanel = useCallback(() => {
    setWorkspaceVisible((visible) => !visible);
  }, []);

  const toggleSharedPanel = useCallback(() => {
    setSharedVisible((visible) => !visible);
  }, []);

  useEffect(() => {
    registerAppCommands({
      closeWorkspace,
      openFolder,
      setCommandPaletteOpen,
      toggleSharedPanel,
      toggleWorkspacePanel,
      workspaceStore,
    });
  }, [closeWorkspace, openFolder, toggleSharedPanel, toggleWorkspacePanel, workspaceStore]);

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
    const nextSize = clamp(
      workspaceLatestSizeRef.current + (event.key === "ArrowLeft" ? -RESIZE_KEYBOARD_STEP_PX : RESIZE_KEYBOARD_STEP_PX),
      WORKSPACE_PANEL_MIN_SIZE,
      WORKSPACE_PANEL_MAX_SIZE,
    );
    applyPanelSize(workspacePanelRef.current, nextSize);
    workspaceLatestSizeRef.current = nextSize;
    setWorkspacePanelState({ size: nextSize });
    persistPanelState(WORKSPACE_PANEL_STORAGE_KEY, { size: nextSize });
  }, []);

  const handleSharedResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const nextSize = clamp(
      sharedLatestSizeRef.current + (event.key === "ArrowLeft" ? RESIZE_KEYBOARD_STEP_PX : -RESIZE_KEYBOARD_STEP_PX),
      SHARED_PANEL_MIN_SIZE,
      SHARED_PANEL_MAX_SIZE,
    );
    applyPanelSize(sharedPanelRef.current, nextSize);
    sharedLatestSizeRef.current = nextSize;
    setSharedPanelState({ size: nextSize });
    persistPanelState(SHARED_PANEL_STORAGE_KEY, { size: nextSize });
  }, []);

  const handleWorkspaceResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    workspaceResizeStartRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startSize: workspaceLatestSizeRef.current,
    };
    startDocumentResizeDrag("workspace");
    setDraggingPanel("workspace");
  }, []);

  const handleSharedResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    sharedResizeStartRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startSize: sharedLatestSizeRef.current,
    };
    startDocumentResizeDrag("shared");
    setDraggingPanel("shared");
  }, []);

  useEffect(() => {
    if (!draggingPanel) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (draggingPanel === "workspace") {
        const dragState = workspaceResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        const nextSize = clamp(
          dragState.startSize + event.clientX - dragState.startClientX,
          WORKSPACE_PANEL_MIN_SIZE,
          WORKSPACE_PANEL_MAX_SIZE,
        );
        workspaceLatestSizeRef.current = nextSize;
        applyPanelSize(workspacePanelRef.current, nextSize);
        return;
      }

      const dragState = sharedResizeStartRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const nextSize = clamp(
        dragState.startSize + dragState.startClientX - event.clientX,
        SHARED_PANEL_MIN_SIZE,
        SHARED_PANEL_MAX_SIZE,
      );
      sharedLatestSizeRef.current = nextSize;
      applyPanelSize(sharedPanelRef.current, nextSize);
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (draggingPanel === "workspace") {
        const dragState = workspaceResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        persistPanelState(WORKSPACE_PANEL_STORAGE_KEY, { size: workspaceLatestSizeRef.current });
        setWorkspacePanelState({ size: workspaceLatestSizeRef.current });
        workspaceResizeStartRef.current = null;
      } else {
        const dragState = sharedResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        persistPanelState(SHARED_PANEL_STORAGE_KEY, { size: sharedLatestSizeRef.current });
        setSharedPanelState({ size: sharedLatestSizeRef.current });
        sharedResizeStartRef.current = null;
      }

      stopDocumentResizeDrag();
      setDraggingPanel(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      stopDocumentResizeDrag();
    };
  }, [draggingPanel]);

  return (
    <div className="flex h-full bg-background text-foreground">
      <ActivityBar />
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />

      <div className="flex min-w-0 flex-1">
        {workspaceVisible && (
          <>
            <div
              ref={workspacePanelRef}
              data-panel="workspace"
              className="min-h-0 shrink-0"
              style={{ flexBasis: workspacePanelState.size, width: workspacePanelState.size }}
            >
              <ScrollArea className="h-full border-r border-border bg-sidebar/70">
                <aside className="flex min-h-full flex-col gap-3 p-3">
                  <WorkspaceSidebar
                    sidebarState={sidebarState}
                    badgeByWorkspaceId={badgeByWorkspaceId}
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
            </div>

            <PanelResizeHandle
              dragging={draggingPanel === "workspace"}
              role="separator"
              aria-valuemin={WORKSPACE_PANEL_MIN_SIZE}
              aria-valuemax={WORKSPACE_PANEL_MAX_SIZE}
              aria-valuenow={Math.round(workspacePanelState.size)}
              aria-label="Resize workspace panel"
              onKeyDown={handleWorkspaceResizeKeyDown}
              onPointerDown={handleWorkspaceResizePointerDown}
            />
          </>
        )}

        <div className="min-h-0 min-w-0 flex-1">
          <main className="flex h-full min-h-0 flex-col border-r border-border bg-background/80 p-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground">Center Terminal</h2>
            <div className="mt-3 min-h-0 flex-1 rounded-md border border-border bg-card p-3">
              <TerminalPane sidebarState={sidebarState} />
            </div>
          </main>
        </div>

        {sharedVisible && (
          <>
            <PanelResizeHandle
              dragging={draggingPanel === "shared"}
              role="separator"
              aria-valuemin={SHARED_PANEL_MIN_SIZE}
              aria-valuemax={SHARED_PANEL_MAX_SIZE}
              aria-valuenow={Math.round(sharedPanelState.size)}
              aria-label="Resize shared panel"
              onKeyDown={handleSharedResizeKeyDown}
              onPointerDown={handleSharedResizePointerDown}
            />

            <div
              ref={sharedPanelRef}
              data-panel="shared"
              className="min-h-0 shrink-0"
              style={{ flexBasis: sharedPanelState.size, width: sharedPanelState.size }}
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function readStoredPanelState(
  storageKey: string,
  fallbackSize: number,
  minSize: number,
  maxSize: number,
): StoredPanelState {
  const fallbackState = { size: fallbackSize };

  try {
    const rawValue = window.localStorage.getItem(storageKey);

    if (!rawValue) {
      return fallbackState;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<{ size: unknown }>;

    if (
      typeof parsedValue.size === "number" &&
      Number.isFinite(parsedValue.size) &&
      parsedValue.size >= minSize &&
      parsedValue.size <= maxSize
    ) {
      return { size: parsedValue.size };
    }

    return fallbackState;
  } catch {
    return fallbackState;
  }
}

function persistPanelState(storageKey: string, state: StoredPanelState): void {
  window.localStorage.setItem(storageKey, JSON.stringify(state));
}

function PanelResizeHandle({
  dragging,
  ...props
}: HTMLAttributes<HTMLDivElement> & { dragging: boolean }) {
  return (
    <div
      tabIndex={0}
      data-resize-handle-state={dragging ? "drag" : "inactive"}
      className="relative z-10 flex w-2 shrink-0 cursor-col-resize items-center justify-center bg-border transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[resize-handle-state=drag]:bg-accent"
      {...props}
    >
      <div className="pointer-events-none z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border">
        <GripVertical aria-hidden="true" className="size-3" strokeWidth={1.75} />
      </div>
    </div>
  );
}

function applyPanelSize(panel: HTMLDivElement | null, size: number): void {
  if (!panel) {
    return;
  }

  panel.style.width = `${size}px`;
  panel.style.flexBasis = `${size}px`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function startDocumentResizeDrag(panel: "workspace" | "shared"): void {
  document.documentElement.dataset.resizingPanel = panel;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function stopDocumentResizeDrag(): void {
  delete document.documentElement.dataset.resizingPanel;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function registerAppCommands({
  closeWorkspace,
  openFolder,
  setCommandPaletteOpen,
  toggleSharedPanel,
  toggleWorkspacePanel,
  workspaceStore,
}: {
  closeWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
  openFolder: () => Promise<void>;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleSharedPanel: () => void;
  toggleWorkspacePanel: () => void;
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
    run: () => toggleWorkspacePanel(),
    title: "Toggle Sidebar",
  });
  registerCommand({
    group: "View",
    id: "view.toggleSharedPanel",
    run: () => toggleSharedPanel(),
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

function useHarnessBadgeStore(): HarnessBadgeStore {
  const harnessBadgeStoreRef = useRef<HarnessBadgeStore | null>(null);

  if (!harnessBadgeStoreRef.current) {
    harnessBadgeStoreRef.current = createHarnessBadgeStore(window.nexusHarness);
  }

  return harnessBadgeStoreRef.current;
}

async function runSidebarMutation(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error("Workspace sidebar: failed to apply workspace mutation.", error);
  }
}
