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
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export type CenterWorkbenchMode = "editor" | "terminal";
export type EditorTabId = string;

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
  tabs: EditorTab[];
  activeTabId: EditorTabId | null;
  lspStatuses: Record<string, LspStatus>;
  setActiveWorkspace(workspaceId: WorkspaceId | null): void;
  setCenterMode(mode: CenterWorkbenchMode): void;
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
  activateTab(tabId: EditorTabId): void;
  updateTabContent(tabId: EditorTabId, content: string): Promise<void>;
  saveTab(tabId: EditorTabId): Promise<void>;
  closeTab(tabId: EditorTabId): Promise<void>;
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

export function createEditorStore(bridge: EditorBridge): EditorStore {
  return createStore<EditorStoreState>((set, get) => ({
    activeWorkspaceId: null,
    centerMode: "terminal",
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
    tabs: [],
    activeTabId: null,
    lspStatuses: {},
    setActiveWorkspace(workspaceId) {
      set((state) => {
        if (!workspaceId) {
          return {
            activeWorkspaceId: null,
            activeTabId: null,
            fileTree: EMPTY_FILE_TREE,
            expandedPaths: {},
            selectedTreePath: null,
            pendingExplorerEdit: null,
            pendingExplorerDelete: null,
            gitBadgeByPath: {},
          };
        }

        const activeTab = state.tabs.find((tab) => tab.workspaceId === workspaceId) ?? null;
        const workspaceChanged = state.activeWorkspaceId !== workspaceId;
        const explorerState = deriveActiveExplorerState(
          workspaceId,
          state.expandedPathsByWorkspace,
          state.selectedTreePathByWorkspace,
          state.pendingExplorerEditsByWorkspace,
          state.pendingExplorerDeletesByWorkspace,
        );

        return {
          activeWorkspaceId: workspaceId,
          activeTabId: activeTab?.id ?? null,
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
      set({ centerMode: mode });
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
      if (get().tabs.some((tab) => tab.id === existingTabId)) {
        set((state) => ({
          activeWorkspaceId: workspaceId,
          activeTabId: existingTabId,
          centerMode: "editor",
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

      set((state) => ({
        activeWorkspaceId: workspaceId,
        centerMode: "editor",
        activeTabId: tab.id,
        tabs: [...state.tabs, tab],
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
    activateTab(tabId) {
      const tab = get().tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return;
      }

      set((state) => ({
        activeWorkspaceId: tab.workspaceId,
        activeTabId: tabId,
        centerMode: "editor",
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
      const tab = get().tabs.find((candidate) => candidate.id === tabId);
      if (!tab || tab.content === content) {
        return;
      }

      const nextDocumentVersion = tab.lspDocumentVersion + 1;
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId
            ? {
                ...candidate,
                content,
                dirty: content !== candidate.savedContent,
                errorMessage: null,
                lspDocumentVersion: nextDocumentVersion,
              }
            : candidate,
        ),
      }));

      if (!tab.language) {
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
      const tab = get().tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return;
      }

      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId
            ? { ...candidate, saving: true, errorMessage: null }
            : candidate,
        ),
      }));

      try {
        const result = await bridge.invoke({
          type: "workspace-files/file/write",
          workspaceId: tab.workspaceId,
          path: tab.path,
          content: tab.content,
          encoding: "utf8",
          expectedVersion: tab.version,
        });
        set((state) => ({
          tabs: state.tabs.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  version: result.version,
                  savedContent: candidate.content,
                  dirty: false,
                  saving: false,
                  errorMessage: null,
                }
              : candidate,
          ),
        }));
        await get().refreshFileTree(tab.workspaceId);
      } catch (error) {
        set((state) => ({
          tabs: state.tabs.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  saving: false,
                  errorMessage: errorMessage(error, "Unable to save file."),
                }
              : candidate,
          ),
        }));
      }
    },
    async closeTab(tabId) {
      const tab = get().tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return;
      }

      set((state) => removeTabFromState(state, tabId));

      if (!tab.language) {
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
            tabs: state.tabs.map((tab) =>
              tab.workspaceId === event.workspaceId &&
              tab.path === event.path &&
              tab.language === event.language
                ? { ...tab, diagnostics: event.diagnostics }
                : tab,
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
  get: () => EditorStoreState,
  workspaceId: WorkspaceId,
  deletedPath: string,
  kind: WorkspaceFileKind,
): void {
  const tabsToClose = get().tabs.filter((tab) => {
    if (tab.workspaceId !== workspaceId) {
      return false;
    }
    if (kind === "file") {
      return tab.path === deletedPath;
    }
    return isPathOrDescendant(tab.path, deletedPath);
  });

  for (const tab of tabsToClose) {
    set((state) => removeTabFromState(state, tab.id));
  }
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
  let nextActiveTabId = state.activeTabId;
  const tabs = state.tabs.map((tab) => {
    if (tab.workspaceId !== workspaceId || !isPathOrDescendant(tab.path, oldPath)) {
      return tab;
    }

    const nextPath = rewritePathPrefix(tab.path, oldPath, newPath);
    const nextLanguage = detectLspLanguage(nextPath);
    const nextTabId = tabIdFor(workspaceId, nextPath);
    if (state.activeTabId === tab.id) {
      nextActiveTabId = nextTabId;
    }

    return {
      ...tab,
      id: nextTabId,
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
  });

  const selectedPath = state.selectedTreePathByWorkspace[workspaceId] ?? null;
  const selectedTreePath =
    selectedPath && isPathOrDescendant(selectedPath, oldPath)
      ? rewritePathPrefix(selectedPath, oldPath, newPath)
      : selectedPath;

  return {
    tabs,
    activeTabId: nextActiveTabId,
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
  tabId: EditorTabId,
): Partial<EditorStoreState> {
  const tabIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (tabIndex < 0) {
    return state;
  }

  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeTabId !== tabId) {
    return { tabs };
  }

  const nextActiveTab = tabs[Math.max(0, tabIndex - 1)] ?? tabs[0] ?? null;
  return {
    tabs,
    activeTabId: nextActiveTab?.id ?? null,
  };
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
      tabs: state.tabs.map((tab) =>
        tab.workspaceId === workspaceId && tab.path === path && tab.language === language
          ? { ...tab, diagnostics: result.diagnostics }
          : tab,
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
    tabs: state.tabs.map((tab) =>
      tab.workspaceId === workspaceId && tab.language === status.language
        ? { ...tab, lspStatus: status }
        : tab,
    ),
  }));
}

function setTabError(set: StoreSet, tabId: EditorTabId, message: string): void {
  set((state) => ({
    tabs: state.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, errorMessage: message } : tab,
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
