import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  LspDiagnostic,
  EditorBridgeEvent,
  EditorBridgeRequest,
  EditorBridgeResultFor,
  WorkspaceFileKind,
  WorkspaceFileTreeNode,
  WorkspaceGitBadgeStatus,
  LspLanguage,
  LspStatus,
  LspTextEdit,
  LspWorkspaceEdit,
  LspWorkspaceEditApplicationResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export type CenterWorkbenchMode = "split" | "editor-max" | "terminal-max";
export type CenterWorkbenchPane = "editor" | "terminal";
export type EditorPaneId = string;
export type EditorTabId = string;

export const CENTER_WORKBENCH_MODE_STORAGE_KEY = "nx.center.mode";
export const DEFAULT_EDITOR_PANE_ID: EditorPaneId = "p0";
export const SECONDARY_EDITOR_PANE_ID: EditorPaneId = "p1";
export const MAX_EDITOR_PANE_COUNT = 2;
export const WORKSPACE_EDIT_CLOSED_FILE_WARNING_THRESHOLD = 10;
export const WORKSPACE_EDIT_CLOSED_FILE_POLICY =
  "WorkspaceEdit text edits open closed files as dirty tabs through the editor bridge; edits are never written to disk automatically.";

export interface EditorBridge {
  invoke<TRequest extends EditorBridgeRequest>(
    request: TRequest,
  ): Promise<EditorBridgeResultFor<TRequest>>;
}

export interface EditorFileTreeState {
  workspaceId: WorkspaceId | null;
  rootPath: string;
  nodes: WorkspaceFileTreeNode[];
  loading: boolean;
  errorMessage: string | null;
  readAt: string | null;
}

export type EditorPendingExplorerEdit =
  | {
      type: "create";
      workspaceId: WorkspaceId;
      parentPath: string | null;
      kind: WorkspaceFileKind;
    }
  | {
      type: "rename";
      workspaceId: WorkspaceId;
      path: string;
      kind: WorkspaceFileKind;
    };

export interface EditorPendingExplorerDelete {
  workspaceId: WorkspaceId;
  path: string;
  kind: WorkspaceFileKind;
}

export interface EditorVisibleTreeNode {
  node: WorkspaceFileTreeNode;
  path: string;
  kind: WorkspaceFileKind;
  depth: number;
  parentPath: string | null;
}

export type EditorTreeSelectionMovement =
  | "previous"
  | "next"
  | "first"
  | "last"
  | "parent"
  | "child";

export interface EditorTab {
  id: EditorTabId;
  workspaceId: WorkspaceId;
  path: string;
  title: string;
  content: string;
  savedContent: string;
  version: string;
  dirty: boolean;
  saving: boolean;
  errorMessage: string | null;
  language: LspLanguage | null;
  monacoLanguage: string;
  lspDocumentVersion: number;
  diagnostics: LspDiagnostic[];
  lspStatus: LspStatus | null;
}

export interface EditorPaneState {
  id: EditorPaneId;
  tabs: EditorTab[];
  activeTabId: EditorTabId | null;
}

export interface EditorPanesState {
  panes: EditorPaneState[];
  activePaneId: EditorPaneId;
}

export interface EditorStoreState {
  activeWorkspaceId: WorkspaceId | null;
  centerMode: CenterWorkbenchMode;
  fileTree: EditorFileTreeState;
  expandedPaths: Record<string, true>;
  expandedPathsByWorkspace: Record<string, Record<string, true>>;
  selectedTreePath: string | null;
  selectedTreePathByWorkspace: Record<string, string>;
  pendingExplorerEdit: EditorPendingExplorerEdit | null;
  pendingExplorerEditsByWorkspace: Record<string, EditorPendingExplorerEdit>;
  pendingExplorerDelete: EditorPendingExplorerDelete | null;
  pendingExplorerDeletesByWorkspace: Record<string, EditorPendingExplorerDelete>;
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  panes: EditorPaneState[];
  activePaneId: EditorPaneId;
  lspStatuses: Record<string, LspStatus>;
  setActiveWorkspace(workspaceId: WorkspaceId | null): void;
  setCenterMode(mode: CenterWorkbenchMode): void;
  activatePane(paneId: EditorPaneId): void;
  splitActivePaneRight(): void;
  moveActiveTabToPane(direction: "left" | "right"): void;
  refreshFileTree(workspaceId?: WorkspaceId | null): Promise<void>;
  toggleDirectory(path: string): void;
  selectTreePath(path: string | null, workspaceId?: WorkspaceId | null): void;
  beginCreateFile(parentPath?: string | null, workspaceId?: WorkspaceId | null): void;
  beginCreateFolder(parentPath?: string | null, workspaceId?: WorkspaceId | null): void;
  beginRename(path: string, kind: WorkspaceFileKind, workspaceId?: WorkspaceId | null): void;
  beginDelete(path: string, kind: WorkspaceFileKind, workspaceId?: WorkspaceId | null): void;
  cancelExplorerEdit(workspaceId?: WorkspaceId | null): void;
  collapseAll(workspaceId?: WorkspaceId | null): void;
  getVisibleTreeNodes(): EditorVisibleTreeNode[];
  moveTreeSelection(movement: EditorTreeSelectionMovement): void;
  createFileNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): Promise<void>;
  deleteFileNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): Promise<void>;
  renameFileNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): Promise<void>;
  openFile(workspaceId: WorkspaceId, path: string): Promise<void>;
  activateTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  updateTabContent(tabId: EditorTabId, content: string): Promise<void>;
  saveTab(tabId: EditorTabId): Promise<void>;
  closeTab(paneId: EditorPaneId, tabId: EditorTabId): Promise<void>;
  applyWorkspaceEdit(
    workspaceId: WorkspaceId,
    edit: LspWorkspaceEdit,
  ): Promise<LspWorkspaceEditApplicationResult>;
  applyEditorEvent(event: EditorBridgeEvent): void;
}

const EMPTY_FILE_TREE: EditorFileTreeState = {
  workspaceId: null,
  rootPath: "",
  nodes: [],
  loading: false,
  errorMessage: null,
  readAt: null,
};

export type EditorStore = StoreApi<EditorStoreState>;

export function migrateCenterWorkbenchMode(mode: unknown): CenterWorkbenchMode {
  if (mode === "split" || mode === "editor-max" || mode === "terminal-max") {
    return mode;
  }

  if (mode === "editor") {
    return "editor-max";
  }

  if (mode === "terminal") {
    return "terminal-max";
  }

  return "split";
}

export function maximizedCenterWorkbenchModeForPane(pane: CenterWorkbenchPane): CenterWorkbenchMode {
  return pane === "editor" ? "editor-max" : "terminal-max";
}

export function toggleCenterWorkbenchMaximize(
  mode: CenterWorkbenchMode,
  pane: CenterWorkbenchPane,
): CenterWorkbenchMode {
  const maximizedMode = maximizedCenterWorkbenchModeForPane(pane);
  return mode === maximizedMode ? "split" : maximizedMode;
}

export function createDefaultEditorPanesState(): EditorPanesState {
  return {
    panes: [
      {
        id: DEFAULT_EDITOR_PANE_ID,
        tabs: [],
        activeTabId: null,
      },
    ],
    activePaneId: DEFAULT_EDITOR_PANE_ID,
  };
}

export function migrateEditorPanesState(persistedState: unknown): EditorPanesState {
  const rawState = unwrapPersistedEditorState(persistedState);

  if (isRecord(rawState) && Array.isArray(rawState.panes)) {
    const panes = rawState.panes
      .slice(0, MAX_EDITOR_PANE_COUNT)
      .map((pane, index): EditorPaneState | null => {
        if (!isRecord(pane)) {
          return null;
        }
        const id = typeof pane.id === "string" && pane.id.length > 0
          ? pane.id
          : index === 0
            ? DEFAULT_EDITOR_PANE_ID
            : SECONDARY_EDITOR_PANE_ID;
        const tabs = Array.isArray(pane.tabs) ? (pane.tabs as EditorTab[]) : [];
        const activeTabId = normalizePaneActiveTabId(tabs, pane.activeTabId);
        return { id, tabs, activeTabId };
      })
      .filter((pane): pane is EditorPaneState => pane !== null);

    if (panes.length > 0) {
      const activePaneId =
        typeof rawState.activePaneId === "string" &&
        panes.some((pane) => pane.id === rawState.activePaneId)
          ? rawState.activePaneId
          : panes[0]!.id;
      return { panes, activePaneId };
    }
  }

  if (isRecord(rawState) && Array.isArray(rawState.tabs)) {
    const tabs = rawState.tabs as EditorTab[];
    return {
      panes: [
        {
          id: DEFAULT_EDITOR_PANE_ID,
          tabs,
          activeTabId: normalizePaneActiveTabId(tabs, rawState.activeTabId),
        },
      ],
      activePaneId: DEFAULT_EDITOR_PANE_ID,
    };
  }

  return createDefaultEditorPanesState();
}

function readStoredCenterWorkbenchMode(): CenterWorkbenchMode {
  try {
    const rawMode = globalThis.localStorage?.getItem(CENTER_WORKBENCH_MODE_STORAGE_KEY) ?? null;
    return migrateCenterWorkbenchMode(parseStoredCenterWorkbenchMode(rawMode));
  } catch {
    return "split";
  }
}

function parseStoredCenterWorkbenchMode(rawMode: string | null): unknown {
  if (!rawMode) {
    return null;
  }

  try {
    const parsedMode = JSON.parse(rawMode) as unknown;
    if (typeof parsedMode === "string") {
      return parsedMode;
    }
    if (
      typeof parsedMode === "object" &&
      parsedMode !== null &&
      "mode" in parsedMode
    ) {
      return (parsedMode as { mode?: unknown }).mode;
    }
  } catch {
    return rawMode;
  }

  return rawMode;
}

function persistCenterWorkbenchMode(mode: CenterWorkbenchMode): void {
  try {
    globalThis.localStorage?.setItem(CENTER_WORKBENCH_MODE_STORAGE_KEY, mode);
  } catch {
    // Runtime state still updates when storage is unavailable.
  }
}

export function createEditorStore(bridge: EditorBridge): EditorStore {
  const initialPanesState = createDefaultEditorPanesState();

  return createStore<EditorStoreState>((set, get) => ({
    activeWorkspaceId: null,
    centerMode: readStoredCenterWorkbenchMode(),
    fileTree: EMPTY_FILE_TREE,
    expandedPaths: {},
    expandedPathsByWorkspace: {},
    selectedTreePath: null,
    selectedTreePathByWorkspace: {},
    pendingExplorerEdit: null,
    pendingExplorerEditsByWorkspace: {},
    pendingExplorerDelete: null,
    pendingExplorerDeletesByWorkspace: {},
    gitBadgeByPath: {},
    panes: initialPanesState.panes,
    activePaneId: initialPanesState.activePaneId,
    lspStatuses: {},
    setActiveWorkspace(workspaceId) {
      set((state) => {
        if (!workspaceId) {
          return {
            activeWorkspaceId: null,
            panes: panesForWorkspace(state.panes, null),
            fileTree: EMPTY_FILE_TREE,
            expandedPaths: {},
            selectedTreePath: null,
            pendingExplorerEdit: null,
            pendingExplorerDelete: null,
            gitBadgeByPath: {},
          };
        }

        const workspaceChanged = state.activeWorkspaceId !== workspaceId;
        const panes = panesForWorkspace(state.panes, workspaceId);
        const explorerState = deriveActiveExplorerState(
          workspaceId,
          state.expandedPathsByWorkspace,
          state.selectedTreePathByWorkspace,
          state.pendingExplorerEditsByWorkspace,
          state.pendingExplorerDeletesByWorkspace,
        );

        return {
          activeWorkspaceId: workspaceId,
          panes,
          activePaneId: resolveActivePaneIdForPanes(panes, state.activePaneId),
          fileTree: workspaceChanged
            ? {
                workspaceId,
                rootPath: "",
                nodes: [],
                loading: false,
                errorMessage: null,
                readAt: null,
              }
            : state.fileTree,
          ...explorerState,
          gitBadgeByPath: workspaceChanged ? {} : state.gitBadgeByPath,
        };
      });
    },
    setCenterMode(mode) {
      persistCenterWorkbenchMode(mode);
      set({ centerMode: mode });
    },
    activatePane(paneId) {
      set((state) => {
        if (!state.panes.some((pane) => pane.id === paneId)) {
          return state;
        }

        return { activePaneId: paneId };
      });
    },
    splitActivePaneRight() {
      set((state) => splitActivePaneRightInState(state));
    },
    moveActiveTabToPane(direction) {
      set((state) => moveActiveTabToPaneInState(state, direction));
    },
    async refreshFileTree(workspaceId = get().activeWorkspaceId) {
      if (!workspaceId) {
        set({
          fileTree: EMPTY_FILE_TREE,
          expandedPaths: {},
          selectedTreePath: null,
          pendingExplorerEdit: null,
          pendingExplorerDelete: null,
          gitBadgeByPath: {},
        });
        return;
      }

      set((state) => ({
        fileTree: {
          ...state.fileTree,
          workspaceId,
          loading: true,
          errorMessage: null,
        },
      }));

      try {
        const result = await bridge.invoke({
          type: "workspace-files/tree/read",
          workspaceId,
          rootPath: null,
        });
        set((state) => {
          if (state.activeWorkspaceId !== workspaceId) {
            return state;
          }

          return {
            fileTree: {
              workspaceId,
              rootPath: result.rootPath,
              nodes: result.nodes,
              loading: false,
              errorMessage: null,
              readAt: result.readAt,
            },
            gitBadgeByPath: collectGitBadges(result.nodes),
          };
        });
      } catch (error) {
        set((state) => ({
          fileTree: {
            ...state.fileTree,
            workspaceId,
            loading: false,
            errorMessage: errorMessage(error, "Unable to read files."),
          },
        }));
      }
    },
    toggleDirectory(path) {
      set((state) => {
        const workspaceId = resolveExplorerWorkspaceId(state);
        if (!workspaceId) {
          return state;
        }

        const expandedPaths = { ...expandedPathsForWorkspace(state, workspaceId) };
        if (expandedPaths[path]) {
          delete expandedPaths[path];
        } else {
          expandedPaths[path] = true;
        }
        return applyWorkspaceExplorerChanges(state, workspaceId, { expandedPaths });
      });
    },
    selectTreePath(path, workspaceId = get().activeWorkspaceId) {
      set((state) => {
        const resolvedWorkspaceId = resolveExplorerWorkspaceId(state, workspaceId);
        if (!resolvedWorkspaceId) {
          return state;
        }

        const changes: WorkspaceExplorerChanges = {
          selectedTreePath: path,
        };
        if (path) {
          changes.expandedPaths = expandAncestorPaths(
            expandedPathsForWorkspace(state, resolvedWorkspaceId),
            path,
          );
        }
        return applyWorkspaceExplorerChanges(state, resolvedWorkspaceId, changes);
      });
    },
    beginCreateFile(parentPath, workspaceId = get().activeWorkspaceId) {
      beginCreateExplorerNode(set, "file", parentPath, workspaceId);
    },
    beginCreateFolder(parentPath, workspaceId = get().activeWorkspaceId) {
      beginCreateExplorerNode(set, "directory", parentPath, workspaceId);
    },
    beginRename(path, kind, workspaceId = get().activeWorkspaceId) {
      set((state) => {
        const resolvedWorkspaceId = resolveExplorerWorkspaceId(state, workspaceId);
        if (!resolvedWorkspaceId) {
          return state;
        }

        return applyWorkspaceExplorerChanges(state, resolvedWorkspaceId, {
          expandedPaths: expandAncestorPaths(
            expandedPathsForWorkspace(state, resolvedWorkspaceId),
            path,
          ),
          selectedTreePath: path,
          pendingExplorerEdit: {
            type: "rename",
            workspaceId: resolvedWorkspaceId,
            path,
            kind,
          },
          pendingExplorerDelete: null,
        });
      });
    },
    beginDelete(path, kind, workspaceId = get().activeWorkspaceId) {
      set((state) => {
        const resolvedWorkspaceId = resolveExplorerWorkspaceId(state, workspaceId);
        if (!resolvedWorkspaceId) {
          return state;
        }

        return applyWorkspaceExplorerChanges(state, resolvedWorkspaceId, {
          expandedPaths: expandAncestorPaths(
            expandedPathsForWorkspace(state, resolvedWorkspaceId),
            path,
          ),
          selectedTreePath: path,
          pendingExplorerEdit: null,
          pendingExplorerDelete: {
            workspaceId: resolvedWorkspaceId,
            path,
            kind,
          },
        });
      });
    },
    cancelExplorerEdit(workspaceId = get().activeWorkspaceId) {
      set((state) => {
        const resolvedWorkspaceId = resolveExplorerWorkspaceId(state, workspaceId);
        if (!resolvedWorkspaceId) {
          return state;
        }

        return applyWorkspaceExplorerChanges(state, resolvedWorkspaceId, {
          pendingExplorerEdit: null,
          pendingExplorerDelete: null,
        });
      });
    },
    collapseAll(workspaceId = get().activeWorkspaceId) {
      set((state) => {
        const resolvedWorkspaceId = resolveExplorerWorkspaceId(state, workspaceId);
        if (!resolvedWorkspaceId) {
          return state;
        }

        return applyWorkspaceExplorerChanges(state, resolvedWorkspaceId, {
          expandedPaths: {},
        });
      });
    },
    getVisibleTreeNodes() {
      const state = get();
      return flattenVisibleFileTree(state.fileTree.nodes, state.expandedPaths);
    },
    moveTreeSelection(movement) {
      set((state) => moveTreeSelectionInState(state, movement));
    },
    async createFileNode(workspaceId, path, kind) {
      const result = await bridge.invoke({
        type: "workspace-files/file/create",
        workspaceId,
        path,
        kind,
        content: kind === "file" ? "" : undefined,
      });
      set((state) => {
        const expandedPaths = expandAncestorPaths(
          expandedPathsForWorkspace(state, workspaceId),
          result.path,
        );
        if (result.kind === "directory") {
          expandedPaths[result.path] = true;
        }

        return applyWorkspaceExplorerChanges(state, workspaceId, {
          expandedPaths,
          selectedTreePath: result.path,
          pendingExplorerEdit: null,
          pendingExplorerDelete: null,
        });
      });
      await get().refreshFileTree(workspaceId);
    },
    async deleteFileNode(workspaceId, path, kind) {
      const result = await bridge.invoke({
        type: "workspace-files/file/delete",
        workspaceId,
        path,
        recursive: kind === "directory",
      });
      removeTabsForDeletedPath(set, get, workspaceId, result.path, kind);
      set((state) => clearDeletedExplorerPath(state, workspaceId, result.path));
      await get().refreshFileTree(workspaceId);
    },
    async renameFileNode(workspaceId, oldPath, newPath) {
      const result = await bridge.invoke({
        type: "workspace-files/file/rename",
        workspaceId,
        oldPath,
        newPath,
      });
      set((state) => renameExplorerPathInState(state, workspaceId, result.oldPath, result.newPath));
      await get().refreshFileTree(workspaceId);
    },
    async openFile(workspaceId, path) {
      const existingTabId = tabIdFor(workspaceId, path);
      const activePaneId = getActiveEditorPane(get()).id;
      const activePane = get().panes.find((pane) => pane.id === activePaneId) ?? null;

      if (activePane?.tabs.some((tab) => tab.id === existingTabId)) {
        persistCenterWorkbenchMode("editor-max");
        set((state) => ({
          activeWorkspaceId: workspaceId,
          centerMode: "editor-max",
          activePaneId,
          panes: activateTabInPane(state.panes, activePaneId, existingTabId),
          ...applyWorkspaceExplorerChanges(
            state,
            workspaceId,
            {
              expandedPaths: expandAncestorPaths(expandedPathsForWorkspace(state, workspaceId), path),
              selectedTreePath: path,
            },
            workspaceId,
          ),
        }));
        return;
      }

      const existingTab = getAllEditorTabs(get()).find((tab) => tab.id === existingTabId) ?? null;
      if (existingTab) {
        persistCenterWorkbenchMode("editor-max");
        set((state) => ({
          activeWorkspaceId: workspaceId,
          centerMode: "editor-max",
          activePaneId,
          panes: addTabToPane(state.panes, activePaneId, existingTab),
          ...applyWorkspaceExplorerChanges(
            state,
            workspaceId,
            {
              expandedPaths: expandAncestorPaths(expandedPathsForWorkspace(state, workspaceId), path),
              selectedTreePath: path,
            },
            workspaceId,
          ),
        }));
        return;
      }

      const readResult = await bridge.invoke({
        type: "workspace-files/file/read",
        workspaceId,
        path,
      });
      const language = detectLspLanguage(readResult.path);
      const lspStatus = language
        ? get().lspStatuses[lspStatusKey(workspaceId, language)] ?? null
        : null;
      const tab: EditorTab = {
        id: tabIdFor(workspaceId, readResult.path),
        workspaceId,
        path: readResult.path,
        title: titleForPath(readResult.path),
        content: readResult.content,
        savedContent: readResult.content,
        version: readResult.version,
        dirty: false,
        saving: false,
        errorMessage: null,
        language,
        monacoLanguage: monacoLanguageIdForPath(readResult.path, language),
        lspDocumentVersion: 1,
        diagnostics: [],
        lspStatus,
      };

      persistCenterWorkbenchMode("editor-max");
      set((state) => ({
        activeWorkspaceId: workspaceId,
        centerMode: "editor-max",
        activePaneId: getActiveEditorPane(state).id,
        panes: addTabToPane(state.panes, getActiveEditorPane(state).id, tab),
        ...applyWorkspaceExplorerChanges(
          state,
          workspaceId,
          {
            expandedPaths: expandAncestorPaths(
              expandedPathsForWorkspace(state, workspaceId),
              readResult.path,
            ),
            selectedTreePath: readResult.path,
          },
          workspaceId,
        ),
      }));

      if (language) {
        const openResult = await bridge.invoke({
          type: "lsp-document/open",
          workspaceId,
          path: readResult.path,
          language,
          content: readResult.content,
          version: tab.lspDocumentVersion,
        });
        applyLspStatus(set, workspaceId, openResult.status);
        await refreshTabDiagnostics(bridge, set, workspaceId, readResult.path, language);
      }
    },
    activateTab(paneId, tabId) {
      const pane = get().panes.find((candidate) => candidate.id === paneId);
      const tab = pane?.tabs.find((candidate) => candidate.id === tabId) ?? null;
      if (!tab) {
        return;
      }

      persistCenterWorkbenchMode("editor-max");
      set((state) => ({
        activeWorkspaceId: tab.workspaceId,
        centerMode: "editor-max",
        activePaneId: paneId,
        panes: activateTabInPane(state.panes, paneId, tabId),
        ...applyWorkspaceExplorerChanges(
          state,
          tab.workspaceId,
          {
            expandedPaths: expandAncestorPaths(
              expandedPathsForWorkspace(state, tab.workspaceId),
              tab.path,
            ),
            selectedTreePath: tab.path,
          },
          tab.workspaceId,
        ),
      }));
    },
    async updateTabContent(tabId, content) {
      const tab = getAllEditorTabs(get()).find((candidate) => candidate.id === tabId);
      if (!tab) {
        return;
      }

      const matchingTabs = getAllEditorTabs(get()).filter((candidate) =>
        isSameWorkspacePath(candidate, tab),
      );
      const contentChanged = matchingTabs.some((candidate) => candidate.content !== content);
      if (
        !contentChanged &&
        matchingTabs.every((candidate) => candidate.dirty && candidate.errorMessage === null)
      ) {
        return;
      }

      const nextDocumentVersion =
        Math.max(...matchingTabs.map((candidate) => candidate.lspDocumentVersion)) + 1;
      set((state) => ({
        panes: mapTabsInPanes(
          state.panes,
          (candidate) => isSameWorkspacePath(candidate, tab),
          (candidate) => ({
            ...candidate,
            content,
            dirty: true,
            errorMessage: null,
            lspDocumentVersion: contentChanged
              ? nextDocumentVersion
              : candidate.lspDocumentVersion,
          }),
        ),
      }));

      if (!tab.language || !contentChanged) {
        return;
      }

      try {
        const result = await bridge.invoke({
          type: "lsp-document/change",
          workspaceId: tab.workspaceId,
          path: tab.path,
          language: tab.language,
          content,
          version: nextDocumentVersion,
        });
        applyLspStatus(set, tab.workspaceId, result.status);
      } catch (error) {
        setTabError(set, tabId, errorMessage(error, "Unable to update language server."));
      }
    },
    async saveTab(tabId) {
      const tab = getAllEditorTabs(get()).find((candidate) => candidate.id === tabId);
      if (!tab) {
        return;
      }

      const contentToSave = tab.content;
      set((state) => ({
        panes: mapTabsInPanes(
          state.panes,
          (candidate) => isSameWorkspacePath(candidate, tab),
          (candidate) => ({ ...candidate, saving: true, errorMessage: null }),
        ),
      }));

      try {
        const result = await bridge.invoke({
          type: "workspace-files/file/write",
          workspaceId: tab.workspaceId,
          path: tab.path,
          content: contentToSave,
          encoding: "utf8",
          expectedVersion: tab.version,
        });
        set((state) => ({
          panes: mapTabsInPanes(
            state.panes,
            (candidate) => isSameWorkspacePath(candidate, tab),
            (candidate) => ({
              ...candidate,
              content: contentToSave,
              version: result.version,
              savedContent: contentToSave,
              dirty: false,
              saving: false,
              errorMessage: null,
            }),
          ),
        }));
        await get().refreshFileTree(tab.workspaceId);
      } catch (error) {
        set((state) => ({
          panes: mapTabsInPanes(
            state.panes,
            (candidate) => isSameWorkspacePath(candidate, tab),
            (candidate) => ({
              ...candidate,
              saving: false,
              errorMessage: errorMessage(error, "Unable to save file."),
            }),
          ),
        }));
      }
    },
    async closeTab(paneId, tabId) {
      const tab = get().panes
        .find((pane) => pane.id === paneId)
        ?.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return;
      }

      const shouldCloseLspDocument = getAllEditorTabs(get()).filter((candidate) =>
        isSameEditorDocument(candidate, tab),
      ).length <= 1;

      set((state) => removeTabFromState(state, paneId, tabId));

      if (!tab.language || !shouldCloseLspDocument) {
        return;
      }

      try {
        await bridge.invoke({
          type: "lsp-document/close",
          workspaceId: tab.workspaceId,
          path: tab.path,
          language: tab.language,
        });
      } catch (error) {
        console.error("Editor store: failed to close LSP document.", error);
      }
    },
    async applyWorkspaceEdit(workspaceId, edit) {
      const plan = await planWorkspaceEditApplication(get(), bridge, workspaceId, edit);
      if (plan.updates.size === 0) {
        return {
          applied: false,
          appliedPaths: [],
          skippedClosedPaths: plan.skippedClosedPaths,
          skippedReadFailures: plan.skippedReadFailures,
          skippedUnsupportedPaths: plan.skippedUnsupportedPaths,
        };
      }

      const tabsToOpen = plan.closedTabs
        .map((tab) => {
          const update = plan.updates.get(tab.path);
          if (!update) {
            return null;
          }
          return {
            ...tab,
            content: update.content,
            dirty: update.content !== tab.savedContent,
            errorMessage: null,
            lspDocumentVersion: update.lspDocumentVersion,
          };
        })
        .filter((tab): tab is EditorTab => tab !== null);

      set((state) => ({
        panes: addTabsToPanePreservingActive(
          mapTabsInPanes(
            state.panes,
            (tab) => tab.workspaceId === workspaceId && plan.updates.has(tab.path),
            (tab) => {
              const update = plan.updates.get(tab.path);
              if (!update) {
                return tab;
              }
              return {
                ...tab,
                content: update.content,
                dirty: update.content !== tab.savedContent,
                errorMessage: null,
                lspDocumentVersion: update.lspDocumentVersion,
              };
            },
          ),
          plan.activePaneId,
          tabsToOpen,
        ),
      }));

      await Promise.all(
        Array.from(plan.updates.entries()).map(async ([path, update]) => {
          if (!update.language) {
            return;
          }

          try {
            const result = await bridge.invoke({
              type: "lsp-document/change",
              workspaceId,
              path,
              language: update.language,
              content: update.content,
              version: update.lspDocumentVersion,
            });
            applyLspStatus(set, workspaceId, result.status);
          } catch (error) {
            setTabError(
              set,
              tabIdFor(workspaceId, path),
              errorMessage(error, "Unable to update language server."),
            );
          }
        }),
      );

      return {
        applied: true,
        appliedPaths: Array.from(plan.updates.keys()),
        skippedClosedPaths: plan.skippedClosedPaths,
        skippedReadFailures: plan.skippedReadFailures,
        skippedUnsupportedPaths: plan.skippedUnsupportedPaths,
      };
    },
    applyEditorEvent(event) {
      switch (event.type) {
        case "workspace-files/watch":
          if (event.workspaceId === get().fileTree.workspaceId) {
            void get().refreshFileTree(event.workspaceId);
          }
          return;
        case "workspace-git-badges/changed":
          set((state) => {
            if (state.fileTree.workspaceId !== event.workspaceId) {
              return state;
            }

            const gitBadgeByPath = { ...state.gitBadgeByPath };
            for (const badge of event.badges) {
              if (badge.status === "clean") {
                delete gitBadgeByPath[badge.path];
              } else {
                gitBadgeByPath[badge.path] = badge.status;
              }
            }
            return { gitBadgeByPath };
          });
          return;
        case "lsp-diagnostics/changed":
          set((state) => ({
            panes: mapTabsInPanes(
              state.panes,
              (tab) =>
                tab.workspaceId === event.workspaceId &&
                tab.path === event.path &&
                tab.language === event.language,
              (tab) => ({ ...tab, diagnostics: event.diagnostics }),
            ),
          }));
          return;
        case "lsp-status/changed":
          applyLspStatus(set, event.workspaceId, event.status);
          return;
      }
    },
  }));
}

export function tabIdFor(workspaceId: WorkspaceId, path: string): EditorTabId {
  return `${workspaceId}::${path}`;
}

export function getActiveEditorPane(state: Pick<EditorStoreState, "panes" | "activePaneId">): EditorPaneState {
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? state.panes[0] ?? {
    id: DEFAULT_EDITOR_PANE_ID,
    tabs: [],
    activeTabId: null,
  };
}

export function getActiveEditorTabId(
  state: Pick<EditorStoreState, "panes" | "activePaneId">,
): EditorTabId | null {
  return getActiveEditorPane(state).activeTabId;
}

export function detectLspLanguage(filePath: string): LspLanguage | null {
  const lowerPath = filePath.toLowerCase();
  if (/\.(ts|tsx|js|jsx)$/.test(lowerPath)) {
    return "typescript";
  }
  if (lowerPath.endsWith(".py")) {
    return "python";
  }
  if (lowerPath.endsWith(".go")) {
    return "go";
  }
  return null;
}

export function monacoLanguageIdForPath(
  filePath: string,
  lspLanguage = detectLspLanguage(filePath),
): string {
  const lowerPath = filePath.toLowerCase();
  if (lspLanguage === "typescript") {
    return lowerPath.endsWith(".js") || lowerPath.endsWith(".jsx") ? "javascript" : "typescript";
  }
  if (lspLanguage === "python") {
    return "python";
  }
  if (lspLanguage === "go") {
    return "go";
  }
  if (lowerPath.endsWith(".json")) {
    return "json";
  }
  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown")) {
    return "markdown";
  }
  if (lowerPath.endsWith(".css")) {
    return "css";
  }
  if (lowerPath.endsWith(".html")) {
    return "html";
  }
  return "plaintext";
}

export function titleForPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

function collectGitBadges(nodes: readonly WorkspaceFileTreeNode[]): Record<string, WorkspaceGitBadgeStatus> {
  const badges: Record<string, WorkspaceGitBadgeStatus> = {};
  for (const node of nodes) {
    if (node.gitBadge && node.gitBadge !== "clean") {
      badges[node.path] = node.gitBadge;
    }
    if (node.children) {
      Object.assign(badges, collectGitBadges(node.children));
    }
  }
  return badges;
}

function unwrapPersistedEditorState(persistedState: unknown): unknown {
  if (
    isRecord(persistedState) &&
    isRecord(persistedState.state) &&
    ("panes" in persistedState.state || "tabs" in persistedState.state)
  ) {
    return persistedState.state;
  }

  return persistedState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePaneActiveTabId(
  tabs: readonly EditorTab[],
  activeTabId: unknown,
): EditorTabId | null {
  if (typeof activeTabId === "string" && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }

  return tabs[0]?.id ?? null;
}

function panesForWorkspace(
  panes: readonly EditorPaneState[],
  workspaceId: WorkspaceId | null,
): EditorPaneState[] {
  return panes.map((pane) => {
    if (!workspaceId) {
      return { ...pane, activeTabId: null };
    }

    const activeTab = pane.activeTabId
      ? pane.tabs.find((tab) => tab.id === pane.activeTabId && tab.workspaceId === workspaceId)
      : null;
    const nextActiveTab = activeTab ?? pane.tabs.find((tab) => tab.workspaceId === workspaceId) ?? null;
    return { ...pane, activeTabId: nextActiveTab?.id ?? null };
  });
}

function resolveActivePaneIdForPanes(
  panes: readonly EditorPaneState[],
  preferredPaneId: EditorPaneId,
): EditorPaneId {
  if (panes.some((pane) => pane.id === preferredPaneId)) {
    return preferredPaneId;
  }

  return panes[0]?.id ?? DEFAULT_EDITOR_PANE_ID;
}

function getAllEditorTabs(state: Pick<EditorStoreState, "panes">): EditorTab[] {
  return state.panes.flatMap((pane) => pane.tabs);
}

function activateTabInPane(
  panes: readonly EditorPaneState[],
  paneId: EditorPaneId,
  tabId: EditorTabId,
): EditorPaneState[] {
  return panes.map((pane) =>
    pane.id === paneId ? { ...pane, activeTabId: tabId } : pane,
  );
}

function addTabToPane(
  panes: readonly EditorPaneState[],
  paneId: EditorPaneId,
  tab: EditorTab,
): EditorPaneState[] {
  return panes.map((pane) => {
    if (pane.id !== paneId) {
      return pane;
    }

    if (pane.tabs.some((candidate) => candidate.id === tab.id)) {
      return { ...pane, activeTabId: tab.id };
    }

    return {
      ...pane,
      tabs: [...pane.tabs, tab],
      activeTabId: tab.id,
    };
  });
}

function addTabsToPanePreservingActive(
  panes: readonly EditorPaneState[],
  paneId: EditorPaneId,
  tabsToAdd: readonly EditorTab[],
): EditorPaneState[] {
  if (tabsToAdd.length === 0) {
    return [...panes];
  }

  const targetPaneId = panes.some((pane) => pane.id === paneId)
    ? paneId
    : panes[0]?.id ?? DEFAULT_EDITOR_PANE_ID;

  return panes.map((pane) => {
    if (pane.id !== targetPaneId) {
      return pane;
    }

    const existingTabIds = new Set(pane.tabs.map((tab) => tab.id));
    const addedTabs: EditorTab[] = [];
    for (const tab of tabsToAdd) {
      if (!existingTabIds.has(tab.id)) {
        existingTabIds.add(tab.id);
        addedTabs.push(tab);
      }
    }

    if (addedTabs.length === 0) {
      return pane;
    }

    return {
      ...pane,
      tabs: [...pane.tabs, ...addedTabs],
      activeTabId: pane.activeTabId,
    };
  });
}

function mapTabsInPanes(
  panes: readonly EditorPaneState[],
  predicate: (tab: EditorTab) => boolean,
  mapper: (tab: EditorTab) => EditorTab,
): EditorPaneState[] {
  return panes.map((pane) => ({
    ...pane,
    tabs: pane.tabs.map((tab) => predicate(tab) ? mapper(tab) : tab),
  }));
}

function splitActivePaneRightInState(state: EditorStoreState): Partial<EditorStoreState> {
  if (state.panes.length >= MAX_EDITOR_PANE_COUNT) {
    const activePane = getActiveEditorPane(state);
    const otherPane = state.panes.find((pane) => pane.id !== activePane.id) ?? null;

    if (activePane.tabs.length === 0 && otherPane) {
      return {
        panes: [otherPane],
        activePaneId: otherPane.id,
      };
    }

    if (otherPane?.tabs.length === 0) {
      return {
        panes: [activePane],
        activePaneId: activePane.id,
      };
    }

    return state;
  }

  const activeIndex = state.panes.findIndex((pane) => pane.id === state.activePaneId);
  const insertIndex = activeIndex >= 0 ? activeIndex + 1 : state.panes.length;
  const newPaneId = state.panes.some((pane) => pane.id === SECONDARY_EDITOR_PANE_ID)
    ? `${SECONDARY_EDITOR_PANE_ID}-${state.panes.length}`
    : SECONDARY_EDITOR_PANE_ID;
  const panes = [...state.panes];
  panes.splice(insertIndex, 0, {
    id: newPaneId,
    tabs: [],
    activeTabId: null,
  });

  return {
    panes,
    activePaneId: newPaneId,
  };
}

function moveActiveTabToPaneInState(
  state: EditorStoreState,
  direction: "left" | "right",
): Partial<EditorStoreState> | EditorStoreState {
  const sourceIndex = state.panes.findIndex((pane) => pane.id === state.activePaneId);
  if (sourceIndex < 0) {
    return state;
  }

  const targetIndex = sourceIndex + (direction === "right" ? 1 : -1);
  const sourcePane = state.panes[sourceIndex];
  const targetPane = state.panes[targetIndex];
  if (!sourcePane || !targetPane || !sourcePane.activeTabId) {
    return state;
  }

  const tabIndex = sourcePane.tabs.findIndex((tab) => tab.id === sourcePane.activeTabId);
  const tab = sourcePane.tabs[tabIndex];
  if (!tab) {
    return state;
  }

  const sourceTabs = sourcePane.tabs.filter((candidate) => candidate.id !== tab.id);
  const sourceActiveTab = sourceTabs[Math.max(0, tabIndex - 1)] ?? sourceTabs[0] ?? null;
  const targetAlreadyHasTab = targetPane.tabs.some((candidate) => candidate.id === tab.id);
  const targetTabs = targetAlreadyHasTab ? targetPane.tabs : [...targetPane.tabs, tab];

  return {
    panes: state.panes.map((pane, index) => {
      if (index === sourceIndex) {
        return {
          ...pane,
          tabs: sourceTabs,
          activeTabId: sourceActiveTab?.id ?? null,
        };
      }
      if (index === targetIndex) {
        return {
          ...pane,
          tabs: targetTabs,
          activeTabId: tab.id,
        };
      }
      return pane;
    }),
    activePaneId: targetPane.id,
  };
}

function isSameEditorDocument(left: EditorTab, right: EditorTab): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.path === right.path &&
    left.language === right.language
  );
}

function isSameWorkspacePath(left: EditorTab, right: EditorTab): boolean {
  return left.workspaceId === right.workspaceId && left.path === right.path;
}

function tabIdTouchesPath(tabId: EditorTabId, workspaceId: WorkspaceId, path: string): boolean {
  return tabId.startsWith(`${workspaceId}::`) && isPathOrDescendant(pathFromTabId(tabId), path);
}

function pathFromTabId(tabId: EditorTabId): string {
  return tabId.split("::").slice(1).join("::");
}

export function flattenVisibleFileTree(
  nodes: readonly WorkspaceFileTreeNode[],
  expandedPaths: Record<string, true>,
): EditorVisibleTreeNode[] {
  const visibleNodes: EditorVisibleTreeNode[] = [];

  function walk(
    treeNodes: readonly WorkspaceFileTreeNode[],
    depth: number,
    parentPath: string | null,
  ): void {
    for (const node of treeNodes) {
      visibleNodes.push({
        node,
        path: node.path,
        kind: node.kind,
        depth,
        parentPath,
      });

      if (node.kind === "directory" && expandedPaths[node.path] && node.children?.length) {
        walk(node.children, depth + 1, node.path);
      }
    }
  }

  walk(nodes, 0, null);
  return visibleNodes;
}

function beginCreateExplorerNode(
  set: StoreSet,
  kind: WorkspaceFileKind,
  parentPath: string | null | undefined,
  workspaceId: WorkspaceId | null | undefined,
): void {
  set((state) => {
    const resolvedWorkspaceId = resolveExplorerWorkspaceId(state, workspaceId);
    if (!resolvedWorkspaceId) {
      return state;
    }

    const resolvedParentPath =
      parentPath === undefined ? inferCreateParentPath(state) : parentPath;
    const expandedPaths = resolvedParentPath
      ? expandAncestorPaths(
          {
            ...expandedPathsForWorkspace(state, resolvedWorkspaceId),
            [resolvedParentPath]: true,
          },
          resolvedParentPath,
        )
      : expandedPathsForWorkspace(state, resolvedWorkspaceId);

    return applyWorkspaceExplorerChanges(state, resolvedWorkspaceId, {
      expandedPaths,
      selectedTreePath: resolvedParentPath,
      pendingExplorerEdit: {
        type: "create",
        workspaceId: resolvedWorkspaceId,
        parentPath: resolvedParentPath,
        kind,
      },
      pendingExplorerDelete: null,
    });
  });
}

function moveTreeSelectionInState(
  state: EditorStoreState,
  movement: EditorTreeSelectionMovement,
): Partial<EditorStoreState> | EditorStoreState {
  const workspaceId = resolveExplorerWorkspaceId(state);
  if (!workspaceId) {
    return state;
  }

  const expandedPaths = expandedPathsForWorkspace(state, workspaceId);
  const visibleNodes = flattenVisibleFileTree(state.fileTree.nodes, expandedPaths);
  if (visibleNodes.length === 0) {
    return state;
  }

  const selectedPath = state.selectedTreePathByWorkspace[workspaceId] ?? null;
  const selectedIndex = selectedPath
    ? visibleNodes.findIndex((visibleNode) => visibleNode.path === selectedPath)
    : -1;
  const selectedVisibleNode = selectedIndex >= 0 ? visibleNodes[selectedIndex] : null;

  if (movement === "first") {
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedTreePath: visibleNodes[0]?.path ?? null,
    });
  }

  if (movement === "last") {
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedTreePath: visibleNodes.at(-1)?.path ?? null,
    });
  }

  if (movement === "next") {
    const nextNode =
      selectedIndex < 0
        ? visibleNodes[0]
        : visibleNodes[Math.min(selectedIndex + 1, visibleNodes.length - 1)];
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedTreePath: nextNode?.path ?? null,
    });
  }

  if (movement === "previous") {
    const previousNode =
      selectedIndex < 0
        ? visibleNodes.at(-1)
        : visibleNodes[Math.max(selectedIndex - 1, 0)];
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedTreePath: previousNode?.path ?? null,
    });
  }

  if (!selectedVisibleNode) {
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedTreePath: visibleNodes[0]?.path ?? null,
    });
  }

  if (movement === "parent") {
    if (
      selectedVisibleNode.kind === "directory" &&
      expandedPaths[selectedVisibleNode.path]
    ) {
      const nextExpandedPaths = { ...expandedPaths };
      delete nextExpandedPaths[selectedVisibleNode.path];
      return applyWorkspaceExplorerChanges(state, workspaceId, {
        expandedPaths: nextExpandedPaths,
      });
    }

    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedTreePath: selectedVisibleNode.parentPath ?? selectedVisibleNode.path,
    });
  }

  if (selectedVisibleNode.kind !== "directory") {
    return state;
  }

  if (!expandedPaths[selectedVisibleNode.path]) {
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      expandedPaths: {
        ...expandedPaths,
        [selectedVisibleNode.path]: true,
      },
    });
  }

  const firstChild = selectedVisibleNode.node.children?.[0] ?? null;
  return applyWorkspaceExplorerChanges(state, workspaceId, {
    selectedTreePath: firstChild?.path ?? selectedVisibleNode.path,
  });
}

function inferCreateParentPath(state: EditorStoreState): string | null {
  const workspaceId = resolveExplorerWorkspaceId(state);
  if (!workspaceId) {
    return null;
  }

  const selectedPath = state.selectedTreePathByWorkspace[workspaceId] ?? null;
  if (!selectedPath) {
    return null;
  }

  const selectedNode = findFileTreeNodeByPath(state.fileTree.nodes, selectedPath);
  if (selectedNode?.kind === "directory") {
    return selectedPath;
  }

  return parentPathFor(selectedPath);
}

function findFileTreeNodeByPath(
  nodes: readonly WorkspaceFileTreeNode[],
  path: string,
): WorkspaceFileTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }

    if (node.children) {
      const descendant = findFileTreeNodeByPath(node.children, path);
      if (descendant) {
        return descendant;
      }
    }
  }

  return null;
}

interface WorkspaceExplorerChanges {
  expandedPaths?: Record<string, true>;
  selectedTreePath?: string | null;
  pendingExplorerEdit?: EditorPendingExplorerEdit | null;
  pendingExplorerDelete?: EditorPendingExplorerDelete | null;
}

function applyWorkspaceExplorerChanges(
  state: EditorStoreState,
  workspaceId: WorkspaceId,
  changes: WorkspaceExplorerChanges,
  activeWorkspaceId = state.activeWorkspaceId,
): Partial<EditorStoreState> {
  const expandedPathsByWorkspace =
    changes.expandedPaths === undefined
      ? state.expandedPathsByWorkspace
      : {
          ...state.expandedPathsByWorkspace,
          [workspaceId]: changes.expandedPaths,
        };
  const selectedTreePathByWorkspace =
    changes.selectedTreePath === undefined
      ? state.selectedTreePathByWorkspace
      : setNullableWorkspaceRecordValue(
          state.selectedTreePathByWorkspace,
          workspaceId,
          changes.selectedTreePath,
        );
  const pendingExplorerEditsByWorkspace =
    changes.pendingExplorerEdit === undefined
      ? state.pendingExplorerEditsByWorkspace
      : setNullableWorkspaceRecordValue(
          state.pendingExplorerEditsByWorkspace,
          workspaceId,
          changes.pendingExplorerEdit,
        );
  const pendingExplorerDeletesByWorkspace =
    changes.pendingExplorerDelete === undefined
      ? state.pendingExplorerDeletesByWorkspace
      : setNullableWorkspaceRecordValue(
          state.pendingExplorerDeletesByWorkspace,
          workspaceId,
          changes.pendingExplorerDelete,
        );

  return {
    expandedPathsByWorkspace,
    selectedTreePathByWorkspace,
    pendingExplorerEditsByWorkspace,
    pendingExplorerDeletesByWorkspace,
    ...deriveActiveExplorerState(
      activeWorkspaceId,
      expandedPathsByWorkspace,
      selectedTreePathByWorkspace,
      pendingExplorerEditsByWorkspace,
      pendingExplorerDeletesByWorkspace,
    ),
  };
}

function deriveActiveExplorerState(
  activeWorkspaceId: WorkspaceId | null,
  expandedPathsByWorkspace: Record<string, Record<string, true>>,
  selectedTreePathByWorkspace: Record<string, string>,
  pendingExplorerEditsByWorkspace: Record<string, EditorPendingExplorerEdit>,
  pendingExplorerDeletesByWorkspace: Record<string, EditorPendingExplorerDelete>,
): Pick<
  EditorStoreState,
  "expandedPaths" | "selectedTreePath" | "pendingExplorerEdit" | "pendingExplorerDelete"
> {
  if (!activeWorkspaceId) {
    return {
      expandedPaths: {},
      selectedTreePath: null,
      pendingExplorerEdit: null,
      pendingExplorerDelete: null,
    };
  }

  return {
    expandedPaths: expandedPathsByWorkspace[activeWorkspaceId] ?? {},
    selectedTreePath: selectedTreePathByWorkspace[activeWorkspaceId] ?? null,
    pendingExplorerEdit: pendingExplorerEditsByWorkspace[activeWorkspaceId] ?? null,
    pendingExplorerDelete: pendingExplorerDeletesByWorkspace[activeWorkspaceId] ?? null,
  };
}

function setNullableWorkspaceRecordValue<TValue>(
  record: Record<string, TValue>,
  workspaceId: WorkspaceId,
  value: TValue | null,
): Record<string, TValue> {
  const nextRecord = { ...record };
  if (value === null) {
    delete nextRecord[workspaceId];
  } else {
    nextRecord[workspaceId] = value;
  }
  return nextRecord;
}

function resolveExplorerWorkspaceId(
  state: EditorStoreState,
  workspaceId: WorkspaceId | null | undefined = state.activeWorkspaceId,
): WorkspaceId | null {
  return workspaceId ?? state.activeWorkspaceId ?? state.fileTree.workspaceId;
}

function expandedPathsForWorkspace(
  state: EditorStoreState,
  workspaceId: WorkspaceId,
): Record<string, true> {
  return state.expandedPathsByWorkspace[workspaceId] ?? {};
}

function expandAncestorPaths(
  expandedPaths: Record<string, true>,
  path: string,
): Record<string, true> {
  const nextExpandedPaths = { ...expandedPaths };
  for (const ancestorPath of ancestorPathsFor(path)) {
    nextExpandedPaths[ancestorPath] = true;
  }
  return nextExpandedPaths;
}

function ancestorPathsFor(path: string): string[] {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const ancestorPaths: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestorPaths.push(parts.slice(0, index).join("/"));
  }
  return ancestorPaths;
}

function parentPathFor(path: string): string | null {
  const ancestors = ancestorPathsFor(path);
  return ancestors.at(-1) ?? null;
}

function isPathOrDescendant(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

function rewritePathPrefix(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) {
    return newPath;
  }
  if (!path.startsWith(`${oldPath}/`)) {
    return path;
  }
  return `${newPath}${path.slice(oldPath.length)}`;
}

function rewriteExpandedPaths(
  expandedPaths: Record<string, true>,
  oldPath: string,
  newPath: string,
): Record<string, true> {
  const nextExpandedPaths: Record<string, true> = {};
  for (const expandedPath of Object.keys(expandedPaths)) {
    nextExpandedPaths[rewritePathPrefix(expandedPath, oldPath, newPath)] = true;
  }
  return nextExpandedPaths;
}

function removeExpandedPathDescendants(
  expandedPaths: Record<string, true>,
  deletedPath: string,
): Record<string, true> {
  const nextExpandedPaths: Record<string, true> = {};
  for (const expandedPath of Object.keys(expandedPaths)) {
    if (!isPathOrDescendant(expandedPath, deletedPath)) {
      nextExpandedPaths[expandedPath] = true;
    }
  }
  return nextExpandedPaths;
}

function removeTabsForDeletedPath(
  set: StoreSet,
  _get: () => EditorStoreState,
  workspaceId: WorkspaceId,
  deletedPath: string,
  kind: WorkspaceFileKind,
): void {
  set((state) =>
    removeTabsMatchingFromState(
      state,
      (tab) =>
        tab.workspaceId === workspaceId &&
        (kind === "file" ? tab.path === deletedPath : isPathOrDescendant(tab.path, deletedPath)),
    ),
  );
}

function clearDeletedExplorerPath(
  state: EditorStoreState,
  workspaceId: WorkspaceId,
  deletedPath: string,
): Partial<EditorStoreState> {
  const selectedPath = state.selectedTreePathByWorkspace[workspaceId] ?? null;
  const pendingEdit = state.pendingExplorerEditsByWorkspace[workspaceId] ?? null;
  const pendingDelete = state.pendingExplorerDeletesByWorkspace[workspaceId] ?? null;

  return applyWorkspaceExplorerChanges(state, workspaceId, {
    expandedPaths: removeExpandedPathDescendants(
      expandedPathsForWorkspace(state, workspaceId),
      deletedPath,
    ),
    selectedTreePath:
      selectedPath && isPathOrDescendant(selectedPath, deletedPath) ? null : selectedPath,
    pendingExplorerEdit:
      pendingEdit && explorerEditTouchesPath(pendingEdit, deletedPath) ? null : pendingEdit,
    pendingExplorerDelete:
      pendingDelete && isPathOrDescendant(pendingDelete.path, deletedPath)
        ? null
        : pendingDelete,
  });
}

function explorerEditTouchesPath(
  pendingEdit: EditorPendingExplorerEdit,
  path: string,
): boolean {
  if (pendingEdit.type === "rename") {
    return isPathOrDescendant(pendingEdit.path, path);
  }
  return pendingEdit.parentPath ? isPathOrDescendant(pendingEdit.parentPath, path) : false;
}

function renameExplorerPathInState(
  state: EditorStoreState,
  workspaceId: WorkspaceId,
  oldPath: string,
  newPath: string,
): Partial<EditorStoreState> {
  const panes = state.panes.map((pane) => ({
    ...pane,
    activeTabId: pane.activeTabId && tabIdTouchesPath(pane.activeTabId, workspaceId, oldPath)
      ? tabIdFor(workspaceId, rewritePathPrefix(pathFromTabId(pane.activeTabId), oldPath, newPath))
      : pane.activeTabId,
    tabs: pane.tabs.map((tab) => {
      if (tab.workspaceId !== workspaceId || !isPathOrDescendant(tab.path, oldPath)) {
        return tab;
      }

      const nextPath = rewritePathPrefix(tab.path, oldPath, newPath);
      const nextLanguage = detectLspLanguage(nextPath);
      return {
        ...tab,
        id: tabIdFor(workspaceId, nextPath),
        path: nextPath,
        title: titleForPath(nextPath),
        language: nextLanguage,
        monacoLanguage: monacoLanguageIdForPath(nextPath, nextLanguage),
        diagnostics:
          tab.language === nextLanguage
            ? tab.diagnostics.map((diagnostic) => ({
                ...diagnostic,
                path: rewritePathPrefix(diagnostic.path, oldPath, newPath),
              }))
            : [],
        lspStatus: nextLanguage
          ? state.lspStatuses[lspStatusKey(workspaceId, nextLanguage)] ?? null
          : null,
      };
    }),
  }));

  const selectedPath = state.selectedTreePathByWorkspace[workspaceId] ?? null;
  const selectedTreePath =
    selectedPath && isPathOrDescendant(selectedPath, oldPath)
      ? rewritePathPrefix(selectedPath, oldPath, newPath)
      : selectedPath;

  return {
    panes,
    ...applyWorkspaceExplorerChanges(state, workspaceId, {
      expandedPaths: rewriteExpandedPaths(
        expandedPathsForWorkspace(state, workspaceId),
        oldPath,
        newPath,
      ),
      selectedTreePath,
      pendingExplorerEdit: null,
      pendingExplorerDelete: null,
    }),
  };
}

function removeTabFromState(
  state: EditorStoreState,
  paneId: EditorPaneId,
  tabId: EditorTabId,
): Partial<EditorStoreState> {
  const paneIndex = state.panes.findIndex((pane) => pane.id === paneId);
  const pane = state.panes[paneIndex];
  const tabIndex = pane?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
  if (tabIndex < 0) {
    return state;
  }

  const tabs = pane!.tabs.filter((tab) => tab.id !== tabId);
  const nextActiveTab = pane!.activeTabId === tabId
    ? tabs[Math.max(0, tabIndex - 1)] ?? tabs[0] ?? null
    : pane!.tabs.find((tab) => tab.id === pane!.activeTabId) ?? null;
  const panes = state.panes.map((candidate, index) =>
    index === paneIndex
      ? { ...candidate, tabs, activeTabId: nextActiveTab?.id ?? null }
      : candidate,
  );

  if (tabs.length === 0 && panes.length > 1) {
    const remainingPanes = panes.filter((candidate) => candidate.id !== paneId);
    const activePaneId = remainingPanes[0]?.id ?? DEFAULT_EDITOR_PANE_ID;
    return {
      panes: remainingPanes,
      activePaneId,
    };
  }

  return {
    panes,
  };
}

function removeTabsMatchingFromState(
  state: EditorStoreState,
  predicate: (tab: EditorTab) => boolean,
): Partial<EditorStoreState> {
  let panes = state.panes.map((pane) => {
    const tabs = pane.tabs.filter((tab) => !predicate(tab));
    const activeTabId = pane.activeTabId && tabs.some((tab) => tab.id === pane.activeTabId)
      ? pane.activeTabId
      : tabs[0]?.id ?? null;
    return { ...pane, tabs, activeTabId };
  });

  if (panes.length > 1) {
    const nonEmptyPanes = panes.filter((pane) => pane.tabs.length > 0);
    panes = nonEmptyPanes.length > 0 ? nonEmptyPanes : [panes[0]!];
  }

  return {
    panes,
    activePaneId: resolveActivePaneIdForPanes(panes, state.activePaneId),
  };
}

interface WorkspaceEditApplicationPlan {
  activePaneId: EditorPaneId;
  updates: Map<
    string,
    {
      content: string;
      language: LspLanguage | null;
      lspDocumentVersion: number;
    }
  >;
  closedTabs: EditorTab[];
  skippedClosedPaths: string[];
  skippedReadFailures: string[];
  skippedUnsupportedPaths: string[];
}

async function planWorkspaceEditApplication(
  state: EditorStoreState,
  bridge: EditorBridge,
  workspaceId: WorkspaceId,
  edit: LspWorkspaceEdit,
): Promise<WorkspaceEditApplicationPlan> {
  const openTabsByPath = new Map<string, EditorTab>();
  for (const tab of getAllEditorTabs(state)) {
    if (tab.workspaceId === workspaceId && !openTabsByPath.has(tab.path)) {
      openTabsByPath.set(tab.path, tab);
    }
  }
  const closedPaths = collectClosedWorkspaceEditPaths(openTabsByPath, edit);
  if (closedPaths.length > WORKSPACE_EDIT_CLOSED_FILE_WARNING_THRESHOLD) {
    console.warn(
      `Editor store: WorkspaceEdit will open ${closedPaths.length} closed files as dirty tabs.`,
      { workspaceId, paths: closedPaths },
    );
  }
  const closedFileReads = await Promise.all(
    closedPaths.map((path) => readClosedWorkspaceEditFile(bridge, state, workspaceId, path)),
  );
  const closedTabsByPath = new Map<string, EditorTab>();
  const skippedReadFailures: string[] = [];
  for (const read of closedFileReads) {
    if (read.tab) {
      closedTabsByPath.set(read.requestedPath, read.tab);
    } else {
      skippedReadFailures.push(read.requestedPath);
    }
  }

  const updates = new Map<
    string,
    {
      content: string;
      language: LspLanguage | null;
      lspDocumentVersion: number;
    }
  >();
  const skippedClosedPaths: string[] = [];
  const skippedUnsupportedPaths: string[] = [];

  for (const change of edit.changes) {
    if (change.edits.length === 0) {
      continue;
    }

    const tab = openTabsByPath.get(change.path) ?? closedTabsByPath.get(change.path);
    if (!tab) {
      if (!skippedReadFailures.includes(change.path)) {
        skippedClosedPaths.push(change.path);
      }
      continue;
    }

    try {
      const updatePath = tab.path;
      const baseContent = updates.get(updatePath)?.content ?? tab.content;
      const nextContent = applyLspTextEdits(baseContent, change.edits);
      const baseVersion = updates.get(updatePath)?.lspDocumentVersion ?? tab.lspDocumentVersion;
      updates.set(updatePath, {
        content: nextContent,
        language: tab.language,
        lspDocumentVersion: baseVersion + 1,
      });
    } catch {
      skippedUnsupportedPaths.push(change.path);
    }
  }

  return {
    activePaneId: state.activePaneId,
    updates,
    closedTabs: Array.from(closedTabsByPath.values()),
    skippedClosedPaths,
    skippedReadFailures,
    skippedUnsupportedPaths,
  };
}

function collectClosedWorkspaceEditPaths(
  openTabsByPath: ReadonlyMap<string, EditorTab>,
  edit: LspWorkspaceEdit,
): string[] {
  const closedPaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const change of edit.changes) {
    if (change.edits.length === 0 || openTabsByPath.has(change.path) || seenPaths.has(change.path)) {
      continue;
    }
    seenPaths.add(change.path);
    closedPaths.push(change.path);
  }
  return closedPaths;
}

interface ClosedWorkspaceEditFileRead {
  requestedPath: string;
  tab: EditorTab | null;
}

async function readClosedWorkspaceEditFile(
  bridge: EditorBridge,
  state: EditorStoreState,
  workspaceId: WorkspaceId,
  path: string,
): Promise<ClosedWorkspaceEditFileRead> {
  try {
    const readResult = await bridge.invoke({
      type: "workspace-files/file/read",
      workspaceId,
      path,
    });
    const language = detectLspLanguage(readResult.path);
    const lspStatus = language
      ? state.lspStatuses[lspStatusKey(workspaceId, language)] ?? null
      : null;
    return {
      requestedPath: path,
      tab: {
        id: tabIdFor(workspaceId, readResult.path),
        workspaceId,
        path: readResult.path,
        title: titleForPath(readResult.path),
        content: readResult.content,
        savedContent: readResult.content,
        version: readResult.version,
        dirty: false,
        saving: false,
        errorMessage: null,
        language,
        monacoLanguage: monacoLanguageIdForPath(readResult.path, language),
        lspDocumentVersion: 1,
        diagnostics: [],
        lspStatus,
      },
    };
  } catch (error) {
    console.warn("Editor store: failed to read closed file for WorkspaceEdit.", {
      workspaceId,
      path,
      error,
    });
    return {
      requestedPath: path,
      tab: null,
    };
  }
}

export function applyLspTextEdits(content: string, edits: readonly LspTextEdit[]): string {
  const lineOffsets = computeLineOffsets(content);
  const resolvedEdits = edits.map((edit) => {
    const startOffset = offsetAt(content, lineOffsets, edit.range.start.line, edit.range.start.character);
    const endOffset = offsetAt(content, lineOffsets, edit.range.end.line, edit.range.end.character);
    if (startOffset > endOffset) {
      throw new Error("LSP text edit range start is after range end.");
    }
    return {
      startOffset,
      endOffset,
      newText: edit.newText,
    };
  });

  resolvedEdits.sort((left, right) => {
    if (left.startOffset !== right.startOffset) {
      return right.startOffset - left.startOffset;
    }
    return right.endOffset - left.endOffset;
  });

  let nextContent = content;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of resolvedEdits) {
    if (edit.endOffset > previousStart) {
      throw new Error("Overlapping LSP text edits are not supported.");
    }
    nextContent =
      nextContent.slice(0, edit.startOffset) +
      edit.newText +
      nextContent.slice(edit.endOffset);
    previousStart = edit.startOffset;
  }

  return nextContent;
}

function computeLineOffsets(content: string): number[] {
  const lineOffsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      lineOffsets.push(index + 1);
    }
  }
  return lineOffsets;
}

function offsetAt(
  content: string,
  lineOffsets: readonly number[],
  line: number,
  character: number,
): number {
  const lineIndex = Math.max(0, Math.min(Math.trunc(line), lineOffsets.length - 1));
  const lineStart = lineOffsets[lineIndex] ?? 0;
  const nextLineStart = lineOffsets[lineIndex + 1] ?? content.length + 1;
  const lineEnd = Math.max(lineStart, Math.min(nextLineStart - 1, content.length));
  return Math.max(lineStart, Math.min(lineStart + Math.max(0, Math.trunc(character)), lineEnd));
}

async function refreshTabDiagnostics(
  bridge: EditorBridge,
  set: StoreSet,
  workspaceId: WorkspaceId,
  path: string,
  language: LspLanguage,
): Promise<void> {
  try {
    const result = await bridge.invoke({
      type: "lsp-diagnostics/read",
      workspaceId,
      path,
      language,
    });
    set((state) => ({
      panes: mapTabsInPanes(
        state.panes,
        (tab) => tab.workspaceId === workspaceId && tab.path === path && tab.language === language,
        (tab) => ({ ...tab, diagnostics: result.diagnostics }),
      ),
    }));
  } catch (error) {
    console.error("Editor store: failed to read LSP diagnostics.", error);
  }
}

function applyLspStatus(set: StoreSet, workspaceId: WorkspaceId, status: LspStatus): void {
  const key = lspStatusKey(workspaceId, status.language);
  set((state) => ({
    lspStatuses: {
      ...state.lspStatuses,
      [key]: status,
    },
    panes: mapTabsInPanes(
      state.panes,
      (tab) => tab.workspaceId === workspaceId && tab.language === status.language,
      (tab) => ({ ...tab, lspStatus: status }),
    ),
  }));
}

function setTabError(set: StoreSet, tabId: EditorTabId, message: string): void {
  set((state) => ({
    panes: mapTabsInPanes(
      state.panes,
      (tab) => tab.id === tabId,
      (tab) => ({ ...tab, errorMessage: message }),
    ),
  }));
}

function lspStatusKey(workspaceId: WorkspaceId, language: LspLanguage): string {
  return `${workspaceId}:${language}`;
}

type StoreSet = StoreApi<EditorStoreState>["setState"];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
