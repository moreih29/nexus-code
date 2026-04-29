import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { CenterWorkbenchActiveArea } from "../components/CenterWorkbench";
import type { SearchResultOpenRequest } from "../components/SearchPanel";
import type { ActivityBarViewId, ActivityBarServiceStore } from "../services/activity-bar-service";
import type { BottomPanelViewId, BottomPanelServiceStore } from "../services/bottom-panel-service";
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
import { type EditorBindings, runEditorMutation } from "./useEditorBindings";

export interface UseAppCommandsInput {
  activityBarStore: ActivityBarServiceStore;
  bottomPanelStore: BottomPanelServiceStore;
  editorBindings: EditorBindings;
  editorWorkspaceService: WorkspaceServiceStore;
  searchStore: SearchStore;
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
  editorWorkspaceService,
  searchStore,
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
    window.setTimeout(focusTerminal, 0);
  }, [bottomPanelStore, editorWorkspaceService]);

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
      openSearchPanel,
      openFolder,
      splitEditorPaneDown: editorBindings.splitDown,
      splitEditorPaneRight: editorBindings.splitRight,
      setCommandPaletteOpen,
      showTerminalPanel,
      tearOffActiveEditorTabToFloating: editorBindings.tearOffActiveTabToFloating,
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
    openFolder,
    openSearchPanel,
    showTerminalPanel,
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

function focusTerminal(): void {
  const terminalTextarea = document.querySelector<HTMLElement>(".xterm-helper-textarea");

  if (terminalTextarea) {
    terminalTextarea.focus();
    return;
  }

  document.querySelector<HTMLElement>('[data-slot="terminal-pane-host"]')?.focus();
}
