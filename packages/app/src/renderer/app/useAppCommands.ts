import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { CenterWorkbenchActiveArea } from "../components/CenterWorkbench";
import type { SearchResultOpenRequest } from "../components/SearchPanel";
import type { ActivityBarViewId, ActivityBarServiceStore } from "../services/activity-bar-service";
import type { BottomPanelViewId, BottomPanelServiceStore } from "../services/bottom-panel-service";
import type { EditorGroupsServiceStore } from "../services/editor-groups-service";
import type { TerminalServiceStore, TerminalTabId } from "../services/terminal-service";
import type { WorkspaceServiceStore } from "../services/workspace-service";
import {
  getKeychordFromKeyboardEvent,
  keyboardRegistryStore,
  normalizeKeychord,
  shouldAllowSingleKeyInput,
  shouldIgnoreKeyboardShortcut,
} from "../stores/keyboard-registry";
import type { SearchStore } from "../stores/search-store";
import type { WorkspaceStore } from "../stores/workspace-store";
import { closeActiveEditorTabOrWorkspace, registerAppCommands } from "./commands";
import {
  moveTerminalToBottomPanel as moveTerminalSessionToBottomPanel,
  moveTerminalToEditorArea as moveTerminalSessionToEditorArea,
} from "./terminal-move-commands";
import { type EditorBindings, runEditorMutation } from "./useEditorBindings";

export interface UseAppCommandsInput {
  activityBarStore: ActivityBarServiceStore;
  bottomPanelStore: BottomPanelServiceStore;
  editorBindings: EditorBindings;
  editorGroupsService: EditorGroupsServiceStore;
  editorWorkspaceService: WorkspaceServiceStore;
  searchStore: SearchStore;
  terminalService: TerminalServiceStore;
  workspaceStore: WorkspaceStore;
}

export interface AppCommandBindings {
  activeCenterArea: CenterWorkbenchActiveArea;
  activateActivityBarView(viewId: ActivityBarViewId): void;
  activateBottomPanelView(viewId: BottomPanelViewId): void;
  activateWorkspace(workspaceId: WorkspaceId): Promise<void>;
  closeWorkspace(workspaceId: WorkspaceId): Promise<void>;
  commandPaletteOpen: boolean;
  dismissSearch(): void;
  goToNextSearchMatch(): void;
  openFolder(): Promise<void>;
  openSearchPanel(replaceMode: boolean): void;
  openSearchResult(request: SearchResultOpenRequest): void;
  moveTerminalToBottomPanel(sessionId?: TerminalTabId): void;
  moveTerminalToEditorArea(sessionId?: TerminalTabId): void;
  setActiveCenterArea(area: CenterWorkbenchActiveArea): void;
  setBottomPanelSize(height: number): void;
  setCommandPaletteOpen(open: boolean): void;
  showTerminalPanel(): void;
  toggleActiveCenterPaneMaximize(): void;
  toggleBottomPanel(): void;
  toggleSideBar(): void;
}

export function useAppCommands({
  activityBarStore,
  bottomPanelStore,
  editorBindings,
  editorGroupsService,
  editorWorkspaceService,
  searchStore,
  terminalService,
  workspaceStore,
}: UseAppCommandsInput): AppCommandBindings {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [activeCenterArea, setActiveCenterArea] = useState<CenterWorkbenchActiveArea>("editor");
  const editorMode = useStore(editorWorkspaceService, (state) => state.centerMode);

  const openFolder = useCallback(async () => {
    await workspaceStore.getState().openFolder();
  }, [workspaceStore]);

  const activateWorkspace = useCallback(async (workspaceId: WorkspaceId) => {
    await workspaceStore.getState().activateWorkspace(workspaceId);
  }, [workspaceStore]);

  const closeWorkspace = useCallback(async (workspaceId: WorkspaceId) => {
    await workspaceStore.getState().closeWorkspace(workspaceId);
  }, [workspaceStore]);

  const toggleSideBar = useCallback(() => {
    activityBarStore.getState().toggleSideBar();
  }, [activityBarStore]);

  const activateActivityBarView = useCallback((viewId: ActivityBarViewId) => {
    activityBarStore.getState().setActiveView(viewId);
    activityBarStore.getState().setSideBarCollapsed(false);
  }, [activityBarStore]);

  const activateBottomPanelView = useCallback((viewId: BottomPanelViewId) => {
    bottomPanelStore.getState().setActiveView(viewId);
    editorWorkspaceService.getState().setCenterMode("split");
    setActiveCenterArea("bottom-panel");
  }, [bottomPanelStore, editorWorkspaceService]);

  const showTerminalPanel = useCallback(() => {
    bottomPanelStore.getState().setActiveView("terminal");
    bottomPanelStore.getState().setExpanded(true);
    editorWorkspaceService.getState().setCenterMode("split");
    setActiveCenterArea("bottom-panel");
    window.setTimeout(() => {
      focusTerminal(terminalService, workspaceStore, bottomPanelStore);
    }, 0);
  }, [bottomPanelStore, editorWorkspaceService, terminalService, workspaceStore]);

  const focusTerminalSoon = useCallback((sessionId: TerminalTabId) => {
    window.setTimeout(() => {
      terminalService.getState().focusSession(sessionId);
    }, 0);
  }, [terminalService]);

  const moveTerminalToEditorArea = useCallback((sessionId?: TerminalTabId) => {
    moveTerminalSessionToEditorArea({
      bottomPanelStore,
      editorGroupsService,
      editorWorkspaceService,
      focusTerminalSoon,
      sessionId,
      terminalService,
      workspaceStore,
      setActiveCenterArea,
    });
  }, [
    bottomPanelStore,
    editorGroupsService,
    editorWorkspaceService,
    focusTerminalSoon,
    terminalService,
    workspaceStore,
  ]);

  const moveTerminalToBottomPanel = useCallback((sessionId?: TerminalTabId) => {
    moveTerminalSessionToBottomPanel({
      bottomPanelStore,
      editorGroupsService,
      editorWorkspaceService,
      focusTerminalSoon,
      sessionId,
      terminalService,
      setActiveCenterArea,
    });
  }, [
    bottomPanelStore,
    editorGroupsService,
    editorWorkspaceService,
    focusTerminalSoon,
    terminalService,
  ]);

  const toggleBottomPanel = useCallback(() => {
    bottomPanelStore.getState().togglePanel();
  }, [bottomPanelStore]);

  const setBottomPanelSize = useCallback((height: number) => {
    bottomPanelStore.getState().setHeight(height);
  }, [bottomPanelStore]);

  const toggleActiveCenterPaneMaximize = useCallback(() => {
    if (activeCenterArea === "bottom-panel") {
      bottomPanelStore.getState().togglePanel();
      return;
    }

    editorWorkspaceService.getState().toggleCenterWorkbenchMaximize("editor");
  }, [activeCenterArea, bottomPanelStore, editorWorkspaceService]);

  const openSearchPanel = useCallback((replaceMode: boolean) => {
    const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
    if (activeWorkspaceId) {
      searchStore.getState().setReplaceMode(activeWorkspaceId, replaceMode);
    }

    activityBarStore.getState().setActiveView("search");
    activityBarStore.getState().setSideBarCollapsed(false);
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>('[data-search-input="query"]')?.focus();
    }, 0);
  }, [activityBarStore, searchStore, workspaceStore]);

  const goToNextSearchMatch = useCallback(() => {
    const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
    if (!activeWorkspaceId) {
      return;
    }

    const nextMatch = searchStore.getState().goToNextMatch(activeWorkspaceId);
    if (!nextMatch) {
      return;
    }

    activityBarStore.getState().setActiveView("search");
    activityBarStore.getState().setSideBarCollapsed(false);
    void runEditorMutation(() => editorBindings.openFile(activeWorkspaceId, nextMatch.path));
  }, [activityBarStore, editorBindings, searchStore, workspaceStore]);

  const dismissSearch = useCallback(() => {
    const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
    if (activeWorkspaceId) {
      searchStore.getState().dismiss(activeWorkspaceId);
    }
    document.querySelector<HTMLInputElement>('[data-search-input="query"]')?.blur();
  }, [searchStore, workspaceStore]);

  const openSearchResult = useCallback(({ workspaceId, match }: SearchResultOpenRequest) => {
    void runEditorMutation(() => editorBindings.openFile(workspaceId, match.path));
  }, [editorBindings]);

  useEffect(() => {
    if (editorMode === "editor-max") {
      setActiveCenterArea("editor");
    } else if (editorMode === "terminal-max") {
      showTerminalPanel();
    }
  }, [editorMode, showTerminalPanel]);

  useEffect(() => {
    registerAppCommands({
      closeWorkspace,
      closeActiveEditorTab: () =>
        closeActiveEditorTabOrWorkspace({
          closeWorkspace,
          closeActiveEditorTab: editorBindings.closeActiveTab,
          hasActiveEditorTab: editorBindings.hasActiveTab,
          workspaceStore,
        }),
      dismissSearch,
      goToNextSearchMatch,
      moveActiveEditorTabToPane: editorBindings.moveActiveTabToPane,
      moveTerminalToBottomPanel,
      moveTerminalToEditorArea,
      openSearchPanel,
      openFolder,
      splitEditorPaneDown: editorBindings.splitDown,
      splitEditorPaneRight: editorBindings.splitRight,
      splitEditorPaneToDirection: editorBindings.splitToDirection,
      setCommandPaletteOpen,
      showTerminalPanel,
      terminalService,
      toggleActiveCenterPaneMaximize,
      toggleBottomPanel,
      toggleSideBar,
      workspaceStore,
    });
  }, [
    closeWorkspace,
    dismissSearch,
    editorBindings,
    goToNextSearchMatch,
    moveTerminalToBottomPanel,
    moveTerminalToEditorArea,
    openFolder,
    openSearchPanel,
    showTerminalPanel,
    terminalService,
    toggleActiveCenterPaneMaximize,
    toggleBottomPanel,
    toggleSideBar,
    workspaceStore,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreKeyboardShortcut(event) || shouldAllowSingleKeyInput(event)) {
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

  return useMemo(() => ({
    activeCenterArea,
    activateActivityBarView,
    activateBottomPanelView,
    activateWorkspace,
    closeWorkspace,
    commandPaletteOpen,
    dismissSearch,
    goToNextSearchMatch,
    moveTerminalToBottomPanel,
    moveTerminalToEditorArea,
    openFolder,
    openSearchPanel,
    openSearchResult,
    setActiveCenterArea,
    setBottomPanelSize,
    setCommandPaletteOpen,
    showTerminalPanel,
    toggleActiveCenterPaneMaximize,
    toggleBottomPanel,
    toggleSideBar,
  }), [
    activeCenterArea,
    activateActivityBarView,
    activateBottomPanelView,
    activateWorkspace,
    closeWorkspace,
    commandPaletteOpen,
    dismissSearch,
    goToNextSearchMatch,
    moveTerminalToBottomPanel,
    moveTerminalToEditorArea,
    openFolder,
    openSearchPanel,
    openSearchResult,
    setBottomPanelSize,
    showTerminalPanel,
    toggleActiveCenterPaneMaximize,
    toggleBottomPanel,
    toggleSideBar,
  ]);
}

function focusTerminal(
  terminalService: TerminalServiceStore,
  workspaceStore: WorkspaceStore,
  bottomPanelStore: BottomPanelServiceStore,
): void {
  const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
  const terminalState = terminalService.getState();
  const bottomPanelState = bottomPanelStore.getState();
  const workspaceTabs = activeWorkspaceId ? terminalState.getTabs(activeWorkspaceId) : terminalState.getTabs();
  const visibleWorkspaceTabs = workspaceTabs.filter((tab) => bottomPanelState.isTerminalAttachedToBottom(tab.id));
  const activeWorkspaceTab = terminalState.getActiveTab(activeWorkspaceId);
  const activeSessionId = activeWorkspaceTab && visibleWorkspaceTabs.some((tab) => tab.id === activeWorkspaceTab.id)
    ? activeWorkspaceTab.id
    : visibleWorkspaceTabs.at(-1)?.id ?? null;

  if (activeSessionId) {
    terminalService.getState().focusSession(activeSessionId);
  }
}
