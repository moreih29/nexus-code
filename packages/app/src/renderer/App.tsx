import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "zustand";
import { Eye } from "lucide-react";

import type { ClaudeSettingsConsentRequest } from "../../../shared/src/contracts/claude/claude-settings";
import type { WorkspaceId } from "../../../shared/src/contracts/workspace/workspace";
import { CenterWorkbench } from "./components/CenterWorkbench";
import { ClaudeSettingsConsentDialog } from "./components/ClaudeSettingsConsentDialog";
import { CommandPalette } from "./components/CommandPalette";
import { EmptyState } from "./components/EmptyState";
import { FileTreePanel } from "./components/FileTreePanel";
import { PanelResizeHandle } from "./components/PanelResizeHandle";
import { SessionHistoryPanel } from "./components/SessionHistoryPanel";
import { SplitEditorPane } from "./components/SplitEditorPane";
import { TerminalPane } from "./components/TerminalPane";
import { ToolFeedPanel } from "./components/ToolFeedPanel";
import { WorkspaceDiffPanel } from "./components/WorkspaceDiffPanel";
import { WorkspaceStrip, workspaceTabId } from "./components/WorkspaceStrip";
import { ScrollArea } from "./components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  getKeychordFromKeyboardEvent,
  keyboardRegistryStore,
  normalizeKeychord,
  shouldAllowSingleKeyInput,
  shouldIgnoreKeyboardShortcut,
} from "./stores/keyboard-registry";
import { createHarnessBadgeStore, type HarnessBadgeStore } from "./stores/harnessBadgeStore";
import { createHarnessToolFeedStore, type HarnessToolFeedStore } from "./stores/harnessToolFeedStore";
import { createHarnessSessionStore, type HarnessSessionStore } from "./stores/harnessSessionStore";
import { createWorkspaceStore, type WorkspaceStore } from "./stores/workspace-store";
import { createEditorStore, getActiveEditorTabId, toggleCenterWorkbenchMaximize, type CenterWorkbenchPane, type EditorStore } from "./stores/editor-store";
import { activateWorkspaceSlot, switchWorkspaceCycle } from "./workspace/workspace-switching-commands";

const WORKSPACE_STRIP_STORAGE_KEY = "nx.layout.workspaceStrip";
const FILETREE_COLUMN_STORAGE_KEY = "nx.layout.filetreeColumn";
const SHARED_PANEL_STORAGE_KEY = "nx.layout.sharedPanel";
const WORKSPACE_STRIP_DEFAULT_SIZE = 160;
const WORKSPACE_STRIP_MIN_SIZE = 120;
const WORKSPACE_STRIP_MAX_SIZE = 220;
const FILETREE_COLUMN_DEFAULT_SIZE = 240;
const FILETREE_COLUMN_MIN_SIZE = 200;
const FILETREE_COLUMN_MAX_SIZE = 400;
const SHARED_PANEL_DEFAULT_SIZE = 320;
const SHARED_PANEL_MIN_SIZE = 256;
const SHARED_PANEL_MAX_SIZE = 512;
const RESIZE_KEYBOARD_STEP_PX = 16;

type ResizePanel = "workspaceStrip" | "filetreeColumn" | "shared";

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
  const harnessToolFeedStore = useHarnessToolFeedStore();
  const harnessSessionStore = useHarnessSessionStore();
  const editorStore = useEditorStore();
  const workspaceStripRef = useRef<HTMLDivElement | null>(null);
  const filetreeColumnRef = useRef<HTMLDivElement | null>(null);
  const sharedPanelRef = useRef<HTMLDivElement | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [workspaceVisible, setWorkspaceVisible] = useState(true);
  const [sharedVisible, setSharedVisible] = useState(true);
  const [activeCenterPane, setActiveCenterPane] = useState<CenterWorkbenchPane>("editor");
  const [draggingPanel, setDraggingPanel] = useState<ResizePanel | null>(null);
  const [workspaceStripState, setWorkspaceStripState] = useState(() =>
    readStoredPanelState(
      WORKSPACE_STRIP_STORAGE_KEY,
      WORKSPACE_STRIP_DEFAULT_SIZE,
      WORKSPACE_STRIP_MIN_SIZE,
      WORKSPACE_STRIP_MAX_SIZE,
    ),
  );
  const [filetreeColumnState, setFiletreeColumnState] = useState(() =>
    readStoredPanelState(
      FILETREE_COLUMN_STORAGE_KEY,
      FILETREE_COLUMN_DEFAULT_SIZE,
      FILETREE_COLUMN_MIN_SIZE,
      FILETREE_COLUMN_MAX_SIZE,
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
  const [claudeConsentRequest, setClaudeConsentRequest] =
    useState<ClaudeSettingsConsentRequest | null>(null);
  const [claudeConsentDontAskAgain, setClaudeConsentDontAskAgain] = useState(false);
  const workspaceStripLatestSizeRef = useRef(workspaceStripState.size);
  const filetreeColumnLatestSizeRef = useRef(filetreeColumnState.size);
  const pendingClaudeConsentRef = useRef<ClaudeSettingsConsentRequest | null>(null);
  const sharedLatestSizeRef = useRef(sharedPanelState.size);
  const workspaceStripResizeStartRef = useRef<ResizeDragState | null>(null);
  const filetreeColumnResizeStartRef = useRef<ResizeDragState | null>(null);
  const sharedResizeStartRef = useRef<ResizeDragState | null>(null);

  const sidebarState = useStore(workspaceStore, (state) => state.sidebarState);
  const refreshSidebarState = useStore(workspaceStore, (state) => state.refreshSidebarState);
  const applySidebarState = useStore(workspaceStore, (state) => state.applySidebarState);
  const openFolder = useStore(workspaceStore, (state) => state.openFolder);
  const activateWorkspace = useStore(workspaceStore, (state) => state.activateWorkspace);
  const closeWorkspace = useStore(workspaceStore, (state) => state.closeWorkspace);
  const badgeByWorkspaceId = useStore(harnessBadgeStore, (state) => state.badgeByWorkspaceId);
  const toolFeedByWorkspaceId = useStore(harnessToolFeedStore, (state) => state.feedByWorkspaceId);
  const sessionByWorkspaceId = useStore(harnessSessionStore, (state) => state.sessionByWorkspaceId);
  const editorFileTree = useStore(editorStore, (state) => state.fileTree);
  const editorExpandedPaths = useStore(editorStore, (state) => state.expandedPaths);
  const editorGitBadgeByPath = useStore(editorStore, (state) => state.gitBadgeByPath);
  const editorSelectedTreePath = useStore(editorStore, (state) => state.selectedTreePath);
  const editorPendingExplorerEdit = useStore(editorStore, (state) => state.pendingExplorerEdit);
  const editorPendingExplorerDelete = useStore(editorStore, (state) => state.pendingExplorerDelete);
  const editorPanes = useStore(editorStore, (state) => state.panes);
  const editorActivePaneId = useStore(editorStore, (state) => state.activePaneId);
  const editorMode = useStore(editorStore, (state) => state.centerMode);
  const setEditorMode = useStore(editorStore, (state) => state.setCenterMode);
  const refreshEditorFileTree = useStore(editorStore, (state) => state.refreshFileTree);
  const toggleEditorDirectory = useStore(editorStore, (state) => state.toggleDirectory);
  const selectEditorTreePath = useStore(editorStore, (state) => state.selectTreePath);
  const beginCreateEditorFile = useStore(editorStore, (state) => state.beginCreateFile);
  const beginCreateEditorFolder = useStore(editorStore, (state) => state.beginCreateFolder);
  const beginRenameEditorNode = useStore(editorStore, (state) => state.beginRename);
  const beginDeleteEditorNode = useStore(editorStore, (state) => state.beginDelete);
  const cancelEditorExplorerEdit = useStore(editorStore, (state) => state.cancelExplorerEdit);
  const collapseAllEditorTree = useStore(editorStore, (state) => state.collapseAll);
  const moveEditorTreeSelection = useStore(editorStore, (state) => state.moveTreeSelection);
  const openEditorFile = useStore(editorStore, (state) => state.openFile);
  const createEditorFileNode = useStore(editorStore, (state) => state.createFileNode);
  const deleteEditorFileNode = useStore(editorStore, (state) => state.deleteFileNode);
  const renameEditorFileNode = useStore(editorStore, (state) => state.renameFileNode);
  const activateEditorTab = useStore(editorStore, (state) => state.activateTab);
  const activateEditorPane = useStore(editorStore, (state) => state.activatePane);
  const splitEditorPaneRight = useStore(editorStore, (state) => state.splitActivePaneRight);
  const moveActiveEditorTabToPane = useStore(editorStore, (state) => state.moveActiveTabToPane);
  const updateEditorTabContent = useStore(editorStore, (state) => state.updateTabContent);
  const saveEditorTab = useStore(editorStore, (state) => state.saveTab);
  const closeEditorTab = useStore(editorStore, (state) => state.closeTab);
  const applyEditorWorkspaceEdit = useStore(editorStore, (state) => state.applyWorkspaceEdit);
  const activeWorkspace = sidebarState.activeWorkspaceId
    ? sidebarState.openWorkspaces.find((workspace) => workspace.id === sidebarState.activeWorkspaceId)
    : undefined;
  const hasOpenWorkspaces = sidebarState.openWorkspaces.length > 0;
  const activeWorkspaceTabId = activeWorkspace ? workspaceTabId(activeWorkspace.id) : undefined;
  const activeToolFeedEntries = sidebarState.activeWorkspaceId
    ? (toolFeedByWorkspaceId[sidebarState.activeWorkspaceId] ?? [])
    : [];
  const activeSessionRef = sidebarState.activeWorkspaceId
    ? (sessionByWorkspaceId[sidebarState.activeWorkspaceId] ?? null)
    : null;
  const diffRefreshSignal = activeToolFeedEntries.at(-1)?.receivedSequence ?? 0;
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

  useEffect(() => {
    const harnessToolFeedState = harnessToolFeedStore.getState();
    harnessToolFeedState.startObserverSubscription();

    return () => {
      harnessToolFeedStore.getState().stopObserverSubscription();
    };
  }, [harnessToolFeedStore]);

  useEffect(() => {
    const harnessSessionState = harnessSessionStore.getState();
    harnessSessionState.startObserverSubscription();

    return () => {
      harnessSessionStore.getState().stopObserverSubscription();
    };
  }, [harnessSessionStore]);

  useEffect(() => {
    const activeWorkspaceId = activeWorkspace?.id ?? null;
    editorStore.getState().setActiveWorkspace(activeWorkspaceId);

    if (activeWorkspaceId) {
      void editorStore.getState().refreshFileTree(activeWorkspaceId).catch((error) => {
        console.error("File tree: failed to refresh active workspace.", error);
      });
    }
  }, [activeWorkspace?.id, editorStore]);

  useEffect(() => {
    const subscription = window.nexusEditor.onEvent((event) => {
      editorStore.getState().applyEditorEvent(event);
    });

    return () => {
      subscription.dispose();
    };
  }, [editorStore]);

  const completeClaudeConsentRequest = useCallback((approved: boolean, dontAskAgain: boolean) => {
    const request = pendingClaudeConsentRef.current;
    if (!request) {
      return;
    }

    pendingClaudeConsentRef.current = null;
    setClaudeConsentRequest(null);
    setClaudeConsentDontAskAgain(false);
    void window.nexusClaudeSettings.respondConsentRequest({
      requestId: request.requestId,
      approved,
      dontAskAgain: approved ? dontAskAgain : false,
    }).catch((error) => {
      console.error("Claude settings consent: failed to send decision.", error);
    });
  }, []);

  useEffect(() => {
    const subscription = window.nexusClaudeSettings.onConsentRequest((request) => {
      if (pendingClaudeConsentRef.current) {
        completeClaudeConsentRequest(false, false);
      }

      pendingClaudeConsentRef.current = request;
      setClaudeConsentDontAskAgain(false);
      setClaudeConsentRequest(request);
    });

    return () => {
      subscription.dispose();
      completeClaudeConsentRequest(false, false);
    };
  }, [completeClaudeConsentRequest]);

  // Cmd+B toggles the Workspace strip + Filetree column as one sidebar bundle.
  // Keep one flag so the two columns cannot drift into separately toggled states.
  const toggleWorkspaceSidebar = useCallback(() => {
    setWorkspaceVisible((visible) => !visible);
  }, []);

  const toggleSharedPanel = useCallback(() => {
    setSharedVisible((visible) => !visible);
  }, []);

  const toggleActiveCenterPaneMaximize = useCallback(() => {
    const currentMode = editorStore.getState().centerMode;
    let pane = activeCenterPane;
    if (currentMode === "editor-max") {
      pane = "editor";
    } else if (currentMode === "terminal-max") {
      pane = "terminal";
    }
    editorStore.getState().setCenterMode(toggleCenterWorkbenchMaximize(currentMode, pane));
  }, [activeCenterPane, editorStore]);

  useEffect(() => {
    if (editorMode === "editor-max") {
      setActiveCenterPane("editor");
    } else if (editorMode === "terminal-max") {
      setActiveCenterPane("terminal");
    }
  }, [editorMode]);

  useEffect(() => {
    registerAppCommands({
      closeWorkspace,
      editorStore,
      moveActiveEditorTabToPane,
      openFolder,
      splitEditorPaneRight,
      setCommandPaletteOpen,
      toggleActiveCenterPaneMaximize,
      toggleSharedPanel,
      toggleWorkspaceSidebar,
      workspaceStore,
    });
  }, [closeWorkspace, editorStore, moveActiveEditorTabToPane, openFolder, splitEditorPaneRight, toggleActiveCenterPaneMaximize, toggleSharedPanel, toggleWorkspaceSidebar, workspaceStore]);

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

  const handleWorkspaceStripResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const nextSize = clamp(
      workspaceStripLatestSizeRef.current + (event.key === "ArrowLeft" ? -RESIZE_KEYBOARD_STEP_PX : RESIZE_KEYBOARD_STEP_PX),
      WORKSPACE_STRIP_MIN_SIZE,
      WORKSPACE_STRIP_MAX_SIZE,
    );
    applyPanelSize(workspaceStripRef.current, nextSize);
    workspaceStripLatestSizeRef.current = nextSize;
    setWorkspaceStripState({ size: nextSize });
    persistPanelState(WORKSPACE_STRIP_STORAGE_KEY, { size: nextSize });
  }, []);

  const handleFiletreeColumnResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const nextSize = clamp(
      filetreeColumnLatestSizeRef.current + (event.key === "ArrowLeft" ? -RESIZE_KEYBOARD_STEP_PX : RESIZE_KEYBOARD_STEP_PX),
      FILETREE_COLUMN_MIN_SIZE,
      FILETREE_COLUMN_MAX_SIZE,
    );
    applyPanelSize(filetreeColumnRef.current, nextSize);
    filetreeColumnLatestSizeRef.current = nextSize;
    setFiletreeColumnState({ size: nextSize });
    persistPanelState(FILETREE_COLUMN_STORAGE_KEY, { size: nextSize });
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

  const handleWorkspaceStripResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    workspaceStripResizeStartRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startSize: workspaceStripLatestSizeRef.current,
    };
    startDocumentResizeDrag("workspaceStrip");
    setDraggingPanel("workspaceStrip");
  }, []);

  const handleFiletreeColumnResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    filetreeColumnResizeStartRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startSize: filetreeColumnLatestSizeRef.current,
    };
    startDocumentResizeDrag("filetreeColumn");
    setDraggingPanel("filetreeColumn");
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
      if (draggingPanel === "workspaceStrip") {
        const dragState = workspaceStripResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        const nextSize = clamp(
          dragState.startSize + event.clientX - dragState.startClientX,
          WORKSPACE_STRIP_MIN_SIZE,
          WORKSPACE_STRIP_MAX_SIZE,
        );
        workspaceStripLatestSizeRef.current = nextSize;
        applyPanelSize(workspaceStripRef.current, nextSize);
        return;
      }

      if (draggingPanel === "filetreeColumn") {
        const dragState = filetreeColumnResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        const nextSize = clamp(
          dragState.startSize + event.clientX - dragState.startClientX,
          FILETREE_COLUMN_MIN_SIZE,
          FILETREE_COLUMN_MAX_SIZE,
        );
        filetreeColumnLatestSizeRef.current = nextSize;
        applyPanelSize(filetreeColumnRef.current, nextSize);
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
      if (draggingPanel === "workspaceStrip") {
        const dragState = workspaceStripResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        persistPanelState(WORKSPACE_STRIP_STORAGE_KEY, { size: workspaceStripLatestSizeRef.current });
        setWorkspaceStripState({ size: workspaceStripLatestSizeRef.current });
        workspaceStripResizeStartRef.current = null;
      } else if (draggingPanel === "filetreeColumn") {
        const dragState = filetreeColumnResizeStartRef.current;
        if (!dragState || event.pointerId !== dragState.pointerId) {
          return;
        }

        persistPanelState(FILETREE_COLUMN_STORAGE_KEY, { size: filetreeColumnLatestSizeRef.current });
        setFiletreeColumnState({ size: filetreeColumnLatestSizeRef.current });
        filetreeColumnResizeStartRef.current = null;
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
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      <ClaudeSettingsConsentDialog
        open={claudeConsentRequest !== null}
        workspaceName={claudeConsentRequest?.workspaceName ?? "this workspace"}
        harnessName={claudeConsentRequest?.harnessName}
        settingsFiles={claudeConsentRequest?.settingsFiles}
        settingsDescription={claudeConsentRequest?.settingsDescription}
        gitignoreEntries={claudeConsentRequest?.gitignoreEntries}
        dontAskAgain={claudeConsentDontAskAgain}
        onOpenChange={(open) => {
          if (!open) {
            completeClaudeConsentRequest(false, false);
          }
        }}
        onDontAskAgainChange={setClaudeConsentDontAskAgain}
        onApprove={(decision) => {
          completeClaudeConsentRequest(true, decision.dontAskAgain);
        }}
        onCancel={() => {
          completeClaudeConsentRequest(false, false);
        }}
      />

      <div className="flex min-w-0 flex-1">
        {workspaceVisible && (
          <>
            <div
              ref={workspaceStripRef}
              data-panel="workspace-strip"
              className="min-h-0 shrink-0 overflow-hidden"
              style={{ flexBasis: workspaceStripState.size, width: workspaceStripState.size }}
            >
              <WorkspaceStrip
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
            </div>

            <PanelResizeHandle
              orientation="vertical"
              dragging={draggingPanel === "workspaceStrip"}
              aria-valuemin={WORKSPACE_STRIP_MIN_SIZE}
              aria-valuemax={WORKSPACE_STRIP_MAX_SIZE}
              aria-valuenow={Math.round(workspaceStripState.size)}
              aria-label="Resize workspace strip"
              onKeyDown={handleWorkspaceStripResizeKeyDown}
              onPointerDown={handleWorkspaceStripResizePointerDown}
            />

            {hasOpenWorkspaces && (
              <>
                <div
                  ref={filetreeColumnRef}
                  data-panel="filetree-column"
                  className="min-h-0 shrink-0 overflow-hidden bg-sidebar/70 p-3"
                  style={{
                    flexBasis: filetreeColumnState.size,
                    width: filetreeColumnState.size,
                  }}
                >
                  <FileTreePanel
                    activeWorkspace={activeWorkspace ?? null}
                    workspaceTabId={activeWorkspaceTabId}
                    fileTree={editorFileTree}
                    expandedPaths={editorExpandedPaths}
                    gitBadgeByPath={editorGitBadgeByPath}
                    selectedTreePath={editorSelectedTreePath}
                    pendingExplorerEdit={editorPendingExplorerEdit}
                    pendingExplorerDelete={editorPendingExplorerDelete}
                    onRefresh={(workspaceId) => {
                      void runEditorMutation(() => refreshEditorFileTree(workspaceId));
                    }}
                    onToggleDirectory={toggleEditorDirectory}
                    onOpenFile={(workspaceId, path) => {
                      void runEditorMutation(() => openEditorFile(workspaceId, path));
                    }}
                    onCreateNode={(workspaceId, path, kind) => {
                      void runEditorMutation(() => createEditorFileNode(workspaceId, path, kind));
                    }}
                    onDeleteNode={(workspaceId, path, kind) => {
                      void runEditorMutation(() => deleteEditorFileNode(workspaceId, path, kind));
                    }}
                    onRenameNode={(workspaceId, oldPath, newPath) => {
                      void runEditorMutation(() => renameEditorFileNode(workspaceId, oldPath, newPath));
                    }}
                    onSelectTreePath={selectEditorTreePath}
                    onBeginCreateFile={beginCreateEditorFile}
                    onBeginCreateFolder={beginCreateEditorFolder}
                    onBeginRename={beginRenameEditorNode}
                    onBeginDelete={beginDeleteEditorNode}
                    onCancelExplorerEdit={cancelEditorExplorerEdit}
                    onCollapseAll={collapseAllEditorTree}
                    onMoveTreeSelection={moveEditorTreeSelection}
                  />
                </div>

                <PanelResizeHandle
                  orientation="vertical"
                  dragging={draggingPanel === "filetreeColumn"}
                  aria-valuemin={FILETREE_COLUMN_MIN_SIZE}
                  aria-valuemax={FILETREE_COLUMN_MAX_SIZE}
                  aria-valuenow={Math.round(filetreeColumnState.size)}
                  aria-label="Resize file tree column"
                  onKeyDown={handleFiletreeColumnResizeKeyDown}
                  onPointerDown={handleFiletreeColumnResizePointerDown}
                />
              </>
            )}
          </>
        )}

        <div className="min-h-0 min-w-0 flex-1">
          <CenterWorkbench
            mode={editorMode}
            onModeChange={setEditorMode}
            activePane={activeCenterPane}
            onActivePaneChange={setActiveCenterPane}
            editorPane={
              <SplitEditorPane
                activeWorkspaceId={activeWorkspace?.id ?? null}
                activeWorkspaceName={activeWorkspace?.displayName ?? null}
                panes={editorPanes}
                activePaneId={editorActivePaneId}
                onActivatePane={activateEditorPane}
                onSplitRight={splitEditorPaneRight}
                onActivateTab={activateEditorTab}
                onCloseTab={(paneId, tabId) => {
                  void runEditorMutation(() => closeEditorTab(paneId, tabId));
                }}
                onSaveTab={(tabId) => {
                  void runEditorMutation(() => saveEditorTab(tabId));
                }}
                onChangeContent={(tabId, content) => {
                  void updateEditorTabContent(tabId, content);
                }}
                onApplyWorkspaceEdit={applyEditorWorkspaceEdit}
              />
            }
            terminalPane={<TerminalPane sidebarState={sidebarState} />}
          />
        </div>

        {sharedVisible && (
          <>
            <PanelResizeHandle
              orientation="vertical"
              dragging={draggingPanel === "shared"}
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
                <aside className="flex min-h-full min-w-0 flex-col p-4">
                  <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground">Right Shared Panel</h2>
                  <Tabs className="mt-3 flex min-h-0 flex-1 flex-col" defaultValue="tool">
                    <TabsList>
                      <TabsTrigger value="tool">Tool</TabsTrigger>
                      <TabsTrigger value="session">Session</TabsTrigger>
                      <TabsTrigger value="diff">Diff</TabsTrigger>
                      <TabsTrigger value="preview">Preview</TabsTrigger>
                    </TabsList>
                    <TabsContent value="tool" className="min-h-0 flex-1 rounded-md border border-border bg-card">
                      <ToolFeedPanel
                        entries={activeToolFeedEntries}
                        activeWorkspaceName={activeWorkspace?.displayName ?? null}
                      />
                    </TabsContent>
                    <TabsContent value="session" className="min-h-0 flex-1 rounded-md border border-border bg-card">
                      <SessionHistoryPanel
                        sessionRef={activeSessionRef}
                        activeWorkspaceName={activeWorkspace?.displayName ?? null}
                        readTranscript={window.nexusClaudeSession.readTranscript}
                      />
                    </TabsContent>
                    <TabsContent value="diff" className="min-h-0 flex-1 rounded-md border border-border bg-card">
                      <WorkspaceDiffPanel
                        workspacePath={activeWorkspace?.absolutePath ?? null}
                        activeWorkspaceName={activeWorkspace?.displayName ?? null}
                        refreshSignal={diffRefreshSignal}
                        readWorkspaceDiff={window.nexusWorkspaceDiff.readWorkspaceDiff}
                      />
                    </TabsContent>
                    <TabsContent value="preview" className="h-48 rounded-md border border-border bg-card">
                      <EmptyState
                        icon={Eye}
                        title="Preview unavailable"
                        description="Markdown or localhost preview will appear here when a preview source is selected."
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

function startDocumentResizeDrag(panel: ResizePanel): void {
  document.documentElement.dataset.resizingPanel = panel;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function stopDocumentResizeDrag(): void {
  delete document.documentElement.dataset.resizingPanel;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

export function registerAppCommands({
  closeWorkspace,
  editorStore,
  moveActiveEditorTabToPane,
  openFolder,
  splitEditorPaneRight,
  setCommandPaletteOpen,
  toggleActiveCenterPaneMaximize,
  toggleSharedPanel,
  toggleWorkspaceSidebar,
  workspaceStore,
}: {
  closeWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
  editorStore: EditorStore;
  moveActiveEditorTabToPane: (direction: "left" | "right") => void;
  openFolder: () => Promise<void>;
  splitEditorPaneRight: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleActiveCenterPaneMaximize: () => void;
  toggleSharedPanel: () => void;
  toggleWorkspaceSidebar: () => void;
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
    run: () => toggleWorkspaceSidebar(),
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
    id: "view.toggleCenterPaneMaximize",
    run: () => toggleActiveCenterPaneMaximize(),
    title: "Toggle Center Pane Maximize",
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
    group: "Editor",
    id: "editor.closeActiveTab",
    run: () =>
      closeActiveEditorTabOrWorkspace({
        closeWorkspace,
        editorStore,
        workspaceStore,
      }),
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
    hidden: true,
    id: "editor.moveActiveTabLeft",
    run: () => moveActiveEditorTabToPane("left"),
    title: "Move Active Editor Tab Left",
  });
  registerCommand({
    group: "Editor",
    hidden: true,
    id: "editor.moveActiveTabRight",
    run: () => moveActiveEditorTabToPane("right"),
    title: "Move Active Editor Tab Right",
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
  registerBinding("Cmd+Shift+M", "view.toggleCenterPaneMaximize");
  registerBinding("Ctrl+`", "view.focusTerminal");
  registerBinding("Cmd+T", "terminal.newTab");
  registerBinding("Cmd+W", "editor.closeActiveTab");
  registerBinding("Cmd+\\", "editor.splitRight");
  registerBinding("Cmd+Alt+ArrowLeft", "editor.moveActiveTabLeft");
  registerBinding("Cmd+Alt+ArrowRight", "editor.moveActiveTabRight");
  registerBinding("Cmd+Shift+W", "workspace.close");
  registerBinding("Cmd+Shift+P", "commandPalette.open");
  registerBinding("Cmd+P", "commandPalette.open");
  registerBinding("Escape", "commandPalette.close");
  registerBinding("Cmd+Shift+[", "terminal.previousTab");
  registerBinding("Cmd+Shift+]", "terminal.nextTab");
}

export async function closeActiveEditorTabOrWorkspace({
  closeWorkspace,
  editorStore,
  workspaceStore,
}: {
  closeWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
  editorStore: EditorStore;
  workspaceStore: WorkspaceStore;
}): Promise<void> {
  const state = editorStore.getState();
  const activePaneId = state.activePaneId;
  const activeTabId = getActiveEditorTabId(state);

  if (activeTabId) {
    await runEditorMutation(() => editorStore.getState().closeTab(activePaneId, activeTabId));
    return;
  }

  const activeWorkspaceId = workspaceStore.getState().sidebarState.activeWorkspaceId;
  if (activeWorkspaceId) {
    await runSidebarMutation(() => closeWorkspace(activeWorkspaceId));
  }
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

function useHarnessToolFeedStore(): HarnessToolFeedStore {
  const harnessToolFeedStoreRef = useRef<HarnessToolFeedStore | null>(null);

  if (!harnessToolFeedStoreRef.current) {
    harnessToolFeedStoreRef.current = createHarnessToolFeedStore(window.nexusHarness);
  }

  return harnessToolFeedStoreRef.current;
}

function useHarnessSessionStore(): HarnessSessionStore {
  const harnessSessionStoreRef = useRef<HarnessSessionStore | null>(null);

  if (!harnessSessionStoreRef.current) {
    harnessSessionStoreRef.current = createHarnessSessionStore(window.nexusHarness);
  }

  return harnessSessionStoreRef.current;
}

function useEditorStore(): EditorStore {
  const editorStoreRef = useRef<EditorStore | null>(null);

  if (!editorStoreRef.current) {
    editorStoreRef.current = createEditorStore(window.nexusEditor);
  }

  return editorStoreRef.current;
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
