import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorGroupSplitDirection } from "../services/editor-groups-service";
import type { TerminalServiceStore } from "../services/terminal-service";
import {
  keyboardRegistryStore,
} from "../stores/keyboard-registry";
import type { WorkspaceStore } from "../stores/workspace-store";
import { activateWorkspaceSlot, switchWorkspaceCycle } from "../workspace/workspace-switching-commands";

export interface RegisterAppCommandsInput {
  closeWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
  closeActiveEditorTab: () => Promise<void>;
  dismissSearch: () => void;
  goToNextSearchMatch: () => void;
  moveActiveEditorTabToPane: (direction: "left" | "right" | "up" | "down") => void;
  moveTerminalToBottomPanel?: () => void;
  moveTerminalToEditorArea?: () => void;
  openSearchPanel: (replaceMode: boolean) => void;
  openFolder: () => Promise<void>;
  splitEditorPaneDown: () => void;
  splitEditorPaneRight: () => void;
  splitEditorPaneToDirection: (direction: EditorGroupSplitDirection) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  showTerminalPanel: () => void;
  terminalService: TerminalServiceStore;
  toggleActiveCenterPaneMaximize: () => void;
  toggleBottomPanel: () => void;
  toggleSideBar: () => void;
  workspaceStore: WorkspaceStore;
}

export function registerAppCommands({
  closeWorkspace,
  closeActiveEditorTab,
  dismissSearch,
  goToNextSearchMatch,
  moveActiveEditorTabToPane,
  moveTerminalToBottomPanel = noop,
  moveTerminalToEditorArea = noop,
  openSearchPanel,
  openFolder,
  splitEditorPaneDown,
  splitEditorPaneRight,
  splitEditorPaneToDirection,
  setCommandPaletteOpen,
  showTerminalPanel,
  terminalService,
  toggleActiveCenterPaneMaximize,
  toggleBottomPanel,
  toggleSideBar,
  workspaceStore,
}: RegisterAppCommandsInput): void {
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
    run: () => toggleSideBar(),
    title: "Toggle Sidebar",
  });
  registerCommand({
    group: "View",
    id: "view.toggleCenterPaneMaximize",
    run: () => toggleActiveCenterPaneMaximize(),
    title: "Toggle Center Pane Maximize",
  });
  registerCommand({
    group: "View",
    id: "view.toggleBottomPanel",
    run: () => toggleBottomPanel(),
    title: "Toggle Bottom Panel",
  });
  registerCommand({
    group: "View",
    id: "view.focusTerminal",
    run: showTerminalPanel,
    title: "Focus Terminal",
  });
  registerCommand({
    group: "Search",
    id: "search.focus",
    run: () => openSearchPanel(false),
    title: "Search in Workspace",
  });
  registerCommand({
    group: "Search",
    id: "search.replace",
    run: () => openSearchPanel(true),
    title: "Replace in Workspace",
  });
  registerCommand({
    group: "Search",
    id: "search.nextMatch",
    run: goToNextSearchMatch,
    title: "Next Search Result",
  });
  registerCommand({
    group: "Terminal",
    id: "terminal.newTab",
    run: () => clickNewTerminalTab({ terminalService, workspaceStore }),
    title: "New Terminal Tab",
  });
  registerCommand({
    group: "Terminal",
    id: "terminal.closeTab",
    run: () => closeActiveTerminalTab({ terminalService, workspaceStore }),
    title: "Close Terminal Tab",
  });
  registerCommand({
    group: "Terminal",
    id: "terminal.moveToEditorArea",
    run: moveTerminalToEditorArea,
    title: "Terminal: Move to Editor Area",
  });
  registerCommand({
    group: "Terminal",
    id: "terminal.moveToBottomPanel",
    run: moveTerminalToBottomPanel,
    title: "Terminal: Move to Bottom Panel",
  });
  registerCommand({
    group: "Editor",
    id: "editor.closeActiveTab",
    run: closeActiveEditorTab,
    title: "Close Active Editor Tab",
  });
  registerCommand({
    group: "Editor",
    id: "editor.splitRight",
    run: splitEditorPaneRight,
    title: "Split Editor Right",
  });
  registerCommand({
    group: "Editor",
    id: "editor.splitToDirection.left",
    run: () => splitEditorPaneToDirection("left"),
    title: "Split Editor to Left",
  });
  registerCommand({
    group: "Editor",
    id: "editor.splitToDirection.right",
    run: () => splitEditorPaneToDirection("right"),
    title: "Split Editor to Right",
  });
  registerCommand({
    group: "Editor",
    id: "editor.splitToDirection.top",
    run: () => splitEditorPaneToDirection("top"),
    title: "Split Editor to Top",
  });
  registerCommand({
    group: "Editor",
    id: "editor.splitToDirection.bottom",
    run: () => splitEditorPaneToDirection("bottom"),
    title: "Split Editor to Bottom",
  });
  registerCommand({
    group: "Editor",
    id: "editor.moveActiveTabLeft",
    run: () => moveActiveEditorTabToPane("left"),
    title: "Move Editor Left",
  });
  registerCommand({
    group: "Editor",
    id: "editor.moveActiveTabRight",
    run: () => moveActiveEditorTabToPane("right"),
    title: "Move Editor Right",
  });
  registerCommand({
    group: "Editor",
    id: "editor.moveActiveTabUp",
    run: () => moveActiveEditorTabToPane("up"),
    title: "Move Editor Up",
  });
  registerCommand({
    group: "Editor",
    id: "editor.moveActiveTabDown",
    run: () => moveActiveEditorTabToPane("down"),
    title: "Move Editor Down",
  });
  registerCommand({
    group: "Editor",
    hidden: true,
    id: "editor.splitDown",
    run: splitEditorPaneDown,
    title: "Split Editor Down",
  });
  registerCommand({
    group: "Terminal",
    hidden: true,
    id: "terminal.previousTab",
    run: () => activateAdjacentTerminalTab("previous", { terminalService, workspaceStore }),
    title: "Previous Terminal Tab",
  });
  registerCommand({
    group: "Terminal",
    hidden: true,
    id: "terminal.nextTab",
    run: () => activateAdjacentTerminalTab("next", { terminalService, workspaceStore }),
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
  registerCommand({
    group: "App",
    hidden: true,
    id: "app.escape",
    run: () => {
      dismissSearch();
      setCommandPaletteOpen(false);
    },
    title: "Dismiss",
  });

  registerBinding("Cmd+1", "workspace.switch.1");
  registerBinding("Cmd+2", "workspace.switch.2");
  registerBinding("Cmd+3", "workspace.switch.3");
  registerBinding("Cmd+O", "workspace.openFolder");
  registerBinding("Cmd+B", "view.toggleSidebar");
  registerBinding("Cmd+Shift+M", "view.toggleCenterPaneMaximize");
  registerBinding("Cmd+J", "view.toggleBottomPanel");
  registerBinding("Ctrl+`", "view.focusTerminal");
  registerBinding("Ctrl+~", "view.focusTerminal");
  registerBinding("Cmd+Shift+F", "search.focus");
  registerBinding("Cmd+Shift+H", "search.replace");
  registerBinding("Cmd+G", "search.nextMatch");
  registerBinding("Cmd+T", "terminal.newTab");
  registerBinding("Cmd+W", "editor.closeActiveTab");
  registerBinding("Cmd+\\", "editor.splitRight");
  registerBinding("Cmd+Alt+ArrowLeft", "editor.moveActiveTabLeft");
  registerBinding("Cmd+Alt+ArrowRight", "editor.moveActiveTabRight");
  registerBinding("Cmd+Alt+ArrowUp", "editor.moveActiveTabUp");
  registerBinding("Cmd+Alt+ArrowDown", "editor.moveActiveTabDown");
  registerBinding("Cmd+Shift+W", "workspace.close");
  registerBinding("Cmd+Shift+P", "commandPalette.open");
  registerBinding("Cmd+P", "commandPalette.open");
  registerBinding("Escape", "app.escape");
  registerBinding("Cmd+Shift+[", "terminal.previousTab");
  registerBinding("Cmd+Shift+]", "terminal.nextTab");
}

export async function closeActiveEditorTabOrWorkspace({
  closeWorkspace,
  closeActiveEditorTab,
  hasActiveEditorTab,
  workspaceStore,
}: {
  closeWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
  closeActiveEditorTab: () => Promise<void>;
  hasActiveEditorTab: () => boolean;
  workspaceStore: WorkspaceStore;
}): Promise<void> {
  if (hasActiveEditorTab()) {
    await runEditorMutation(closeActiveEditorTab);
    return;
  }

  const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
  if (activeWorkspaceId) {
    await runSidebarMutation(() => closeWorkspace(activeWorkspaceId));
  }
}

function clickNewTerminalTab({
  terminalService,
  workspaceStore,
}: {
  terminalService: TerminalServiceStore;
  workspaceStore: WorkspaceStore;
}): Promise<void> | void {
  const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
  if (!activeWorkspaceId) {
    return;
  }

  return terminalService.getState().requestNewTab(activeWorkspaceId)
    .then(() => undefined)
    .catch((error) => {
      console.error("Terminal: failed to create terminal tab.", error);
    });
}

function closeActiveTerminalTab({
  terminalService,
  workspaceStore,
}: {
  terminalService: TerminalServiceStore;
  workspaceStore: WorkspaceStore;
}): void {
  const activeTab = getActiveWorkspaceTerminalTab({ terminalService, workspaceStore });
  if (activeTab) {
    terminalService.getState().closeTab(activeTab.id);
  }
}

function activateAdjacentTerminalTab(
  direction: "next" | "previous",
  {
    terminalService,
    workspaceStore,
  }: {
    terminalService: TerminalServiceStore;
    workspaceStore: WorkspaceStore;
  },
): void {
  const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
  if (!activeWorkspaceId) {
    return;
  }

  const terminalState = terminalService.getState();
  const tabs = terminalState.getTabs(activeWorkspaceId);
  if (tabs.length === 0) {
    return;
  }

  const activeTab = terminalState.getActiveTab(activeWorkspaceId);
  const activeIndex = activeTab ? tabs.findIndex((tab) => tab.id === activeTab.id) : -1;
  const currentIndex = activeIndex >= 0 ? activeIndex : 0;
  const delta = direction === "next" ? 1 : -1;
  const targetIndex = (currentIndex + delta + tabs.length) % tabs.length;
  const targetTab = tabs[targetIndex];
  if (targetTab) {
    terminalState.setActiveTab(targetTab.id);
  }
}

function getActiveWorkspaceTerminalTab({
  terminalService,
  workspaceStore,
}: {
  terminalService: TerminalServiceStore;
  workspaceStore: WorkspaceStore;
}) {
  const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
  return terminalService.getState().getActiveTab(activeWorkspaceId) ?? terminalService.getState().getActiveTab();
}

async function runSidebarMutation(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error("Workspace sidebar: failed to apply workspace mutation.", error);
  }
}

async function runEditorMutation(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error("Editor: failed to apply editor mutation.", error);
  }
}

function noop(): void {
  // no-op
}
