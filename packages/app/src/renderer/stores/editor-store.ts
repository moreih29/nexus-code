import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  E4Diagnostic,
  E4EditorEvent,
  E4EditorRequest,
  E4EditorResultFor,
  E4FileKind,
  E4FileTreeNode,
  E4GitBadgeStatus,
  E4LspLanguage,
  E4LspStatus,
} from "../../../../shared/src/contracts/e4-editor";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";

export type CenterWorkbenchMode = "editor" | "terminal";
export type EditorTabId = string;

export interface EditorBridge {
  invoke<TRequest extends E4EditorRequest>(
    request: TRequest,
  ): Promise<E4EditorResultFor<TRequest>>;
}

export interface EditorFileTreeState {
  workspaceId: WorkspaceId | null;
  rootPath: string;
  nodes: E4FileTreeNode[];
  loading: boolean;
  errorMessage: string | null;
  readAt: string | null;
}

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
  language: E4LspLanguage | null;
  monacoLanguage: string;
  lspDocumentVersion: number;
  diagnostics: E4Diagnostic[];
  lspStatus: E4LspStatus | null;
}

export interface EditorStoreState {
  activeWorkspaceId: WorkspaceId | null;
  centerMode: CenterWorkbenchMode;
  fileTree: EditorFileTreeState;
  expandedPaths: Record<string, true>;
  gitBadgeByPath: Record<string, E4GitBadgeStatus>;
  tabs: EditorTab[];
  activeTabId: EditorTabId | null;
  lspStatuses: Record<string, E4LspStatus>;
  setActiveWorkspace(workspaceId: WorkspaceId | null): void;
  setCenterMode(mode: CenterWorkbenchMode): void;
  refreshFileTree(workspaceId?: WorkspaceId | null): Promise<void>;
  toggleDirectory(path: string): void;
  createFileNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): Promise<void>;
  deleteFileNode(workspaceId: WorkspaceId, path: string, kind: E4FileKind): Promise<void>;
  renameFileNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): Promise<void>;
  openFile(workspaceId: WorkspaceId, path: string): Promise<void>;
  activateTab(tabId: EditorTabId): void;
  updateTabContent(tabId: EditorTabId, content: string): Promise<void>;
  saveTab(tabId: EditorTabId): Promise<void>;
  closeTab(tabId: EditorTabId): Promise<void>;
  applyEditorEvent(event: E4EditorEvent): void;
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
            gitBadgeByPath: {},
          };
        }

        const activeTab = state.tabs.find((tab) => tab.workspaceId === workspaceId) ?? null;
        const workspaceChanged = state.activeWorkspaceId !== workspaceId;

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
          expandedPaths: workspaceChanged ? {} : state.expandedPaths,
          gitBadgeByPath: workspaceChanged ? {} : state.gitBadgeByPath,
        };
      });
    },
    setCenterMode(mode) {
      set({ centerMode: mode });
    },
    async refreshFileTree(workspaceId = get().activeWorkspaceId) {
      if (!workspaceId) {
        set({ fileTree: EMPTY_FILE_TREE, expandedPaths: {}, gitBadgeByPath: {} });
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
          type: "e4/file-tree/read",
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
        const expandedPaths = { ...state.expandedPaths };
        if (expandedPaths[path]) {
          delete expandedPaths[path];
        } else {
          expandedPaths[path] = true;
        }
        return { expandedPaths };
      });
    },
    async createFileNode(workspaceId, path, kind) {
      await bridge.invoke({
        type: "e4/file/create",
        workspaceId,
        path,
        kind,
        content: kind === "file" ? "" : undefined,
      });
      await get().refreshFileTree(workspaceId);
    },
    async deleteFileNode(workspaceId, path, kind) {
      await bridge.invoke({
        type: "e4/file/delete",
        workspaceId,
        path,
        recursive: kind === "directory",
      });
      removeTabsForDeletedPath(set, get, workspaceId, path, kind);
      await get().refreshFileTree(workspaceId);
    },
    async renameFileNode(workspaceId, oldPath, newPath) {
      const result = await bridge.invoke({
        type: "e4/file/rename",
        workspaceId,
        oldPath,
        newPath,
      });
      set((state) => renameOpenTab(state, workspaceId, result.oldPath, result.newPath));
      await get().refreshFileTree(workspaceId);
    },
    async openFile(workspaceId, path) {
      const existingTabId = tabIdFor(workspaceId, path);
      if (get().tabs.some((tab) => tab.id === existingTabId)) {
        set({ activeWorkspaceId: workspaceId, activeTabId: existingTabId, centerMode: "editor" });
        return;
      }

      const readResult = await bridge.invoke({
        type: "e4/file/read",
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
      }));

      if (language) {
        const openResult = await bridge.invoke({
          type: "e4/lsp-document/open",
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

      set({ activeWorkspaceId: tab.workspaceId, activeTabId: tabId, centerMode: "editor" });
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
          type: "e4/lsp-document/change",
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
          type: "e4/file/write",
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
          type: "e4/lsp-document/close",
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
        case "e4/file/watch":
          if (event.workspaceId === get().fileTree.workspaceId) {
            void get().refreshFileTree(event.workspaceId);
          }
          return;
        case "e4/git-badges/changed":
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
        case "e4/lsp-diagnostics/changed":
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
        case "e4/lsp-status/changed":
          applyLspStatus(set, event.workspaceId, event.status);
          return;
      }
    },
  }));
}

export function tabIdFor(workspaceId: WorkspaceId, path: string): EditorTabId {
  return `${workspaceId}::${path}`;
}

export function detectLspLanguage(filePath: string): E4LspLanguage | null {
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

function collectGitBadges(nodes: readonly E4FileTreeNode[]): Record<string, E4GitBadgeStatus> {
  const badges: Record<string, E4GitBadgeStatus> = {};
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

function removeTabsForDeletedPath(
  set: StoreSet,
  get: () => EditorStoreState,
  workspaceId: WorkspaceId,
  deletedPath: string,
  kind: E4FileKind,
): void {
  const tabsToClose = get().tabs.filter((tab) => {
    if (tab.workspaceId !== workspaceId) {
      return false;
    }
    if (kind === "file") {
      return tab.path === deletedPath;
    }
    return tab.path === deletedPath || tab.path.startsWith(`${deletedPath}/`);
  });

  for (const tab of tabsToClose) {
    set((state) => removeTabFromState(state, tab.id));
  }
}

function renameOpenTab(
  state: EditorStoreState,
  workspaceId: WorkspaceId,
  oldPath: string,
  newPath: string,
): Partial<EditorStoreState> {
  const oldTabId = tabIdFor(workspaceId, oldPath);
  const newTabId = tabIdFor(workspaceId, newPath);
  let renamed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== oldTabId) {
      return tab;
    }
    renamed = true;
    return {
      ...tab,
      id: newTabId,
      path: newPath,
      title: titleForPath(newPath),
      language: detectLspLanguage(newPath),
      monacoLanguage: monacoLanguageIdForPath(newPath),
      diagnostics: [],
    };
  });

  if (!renamed) {
    return state;
  }

  return {
    tabs,
    activeTabId: state.activeTabId === oldTabId ? newTabId : state.activeTabId,
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
  language: E4LspLanguage,
): Promise<void> {
  try {
    const result = await bridge.invoke({
      type: "e4/lsp-diagnostics/read",
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

function applyLspStatus(set: StoreSet, workspaceId: WorkspaceId, status: E4LspStatus): void {
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

function lspStatusKey(workspaceId: WorkspaceId, language: E4LspLanguage): string {
  return `${workspaceId}:${language}`;
}

type StoreSet = StoreApi<EditorStoreState>["setState"];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
