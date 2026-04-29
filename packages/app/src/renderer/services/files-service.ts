import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  EditorBridgeRequest,
  EditorBridgeResultFor,
  WorkspaceFileCreateResult,
  WorkspaceFileDeleteResult,
  WorkspaceFileKind,
  WorkspaceFileRenameResult,
  WorkspaceFileTreeNode,
  WorkspaceFileTreeReadResult,
  WorkspaceFileWatchEvent,
  WorkspaceGitBadge,
  WorkspaceGitBadgesReadResult,
  WorkspaceGitBadgeStatus,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorBridge } from "./editor-types";

export type FilesRefreshReason = "manual" | "watch" | "crud";
export type FilesTreeSelectionMovement =
  | "previous"
  | "next"
  | "first"
  | "last"
  | "parent"
  | "child";

export interface FilesTreeSnapshot {
  workspaceId: WorkspaceId;
  rootPath: string;
  nodes: WorkspaceFileTreeNode[];
  readAt?: string | null;
}

export interface FilesFileTreeState {
  workspaceId: WorkspaceId | null;
  rootPath: string;
  nodes: WorkspaceFileTreeNode[];
  loading: boolean;
  errorMessage: string | null;
  readAt: string | null;
}

export type FilesPendingExplorerEdit =
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

export interface FilesPendingExplorerDelete {
  workspaceId: WorkspaceId;
  path: string;
  kind: WorkspaceFileKind;
}

export interface FilesVisibleTreeNode {
  node: WorkspaceFileTreeNode;
  path: string;
  kind: WorkspaceFileKind;
  depth: number;
  parentPath: string | null;
}

export interface IFilesService {
  fileTree: FilesFileTreeState;
  workspaceId: WorkspaceId | null;
  rootPath: string | null;
  nodes: WorkspaceFileTreeNode[];
  loading: boolean;
  errorMessage: string | null;
  readAt: string | null;
  refreshRequested: boolean;
  refreshReason: FilesRefreshReason | null;
  lastWatchEvent: WorkspaceFileWatchEvent | null;
  selectedPath: string | null;
  expandedPaths: Record<string, true>;
  pendingExplorerEdit: FilesPendingExplorerEdit | null;
  pendingExplorerDelete: FilesPendingExplorerDelete | null;
  expandedPathsByWorkspace: Record<string, Record<string, true>>;
  selectedPathByWorkspace: Record<string, string>;
  pendingExplorerEditsByWorkspace: Record<string, FilesPendingExplorerEdit>;
  pendingExplorerDeletesByWorkspace: Record<string, FilesPendingExplorerDelete>;
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  setActiveWorkspace(workspaceId: WorkspaceId | null): void;
  beginRefresh(workspaceId: WorkspaceId, rootPath?: string | null): void;
  refreshFileTree(workspaceId?: WorkspaceId | null): Promise<WorkspaceFileTreeReadResult | null>;
  markRefreshRequested(reason: FilesRefreshReason): void;
  clearRefreshRequest(): void;
  setTree(snapshot: FilesTreeSnapshot): void;
  applyTreeReadResult(result: WorkspaceFileTreeReadResult): void;
  setLoading(loading: boolean): void;
  setError(errorMessage: string | null): void;
  selectPath(path: string | null): void;
  toggleDirectory(path: string): void;
  expandDirectory(path: string): void;
  collapseDirectory(path: string): void;
  collapseAll(): void;
  expandAncestors(path: string): void;
  beginCreateFile(parentPath?: string | null, workspaceId?: WorkspaceId | null): void;
  beginCreateFolder(parentPath?: string | null, workspaceId?: WorkspaceId | null): void;
  beginRename(path: string, kind: WorkspaceFileKind, workspaceId?: WorkspaceId | null): void;
  beginDelete(path: string, kind: WorkspaceFileKind, workspaceId?: WorkspaceId | null): void;
  cancelExplorerEdit(): void;
  moveTreeSelection(movement: FilesTreeSelectionMovement): void;
  createFileNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): Promise<WorkspaceFileCreateResult>;
  deleteFileNode(workspaceId: WorkspaceId, path: string, kind: WorkspaceFileKind): Promise<WorkspaceFileDeleteResult>;
  renameFileNode(workspaceId: WorkspaceId, oldPath: string, newPath: string): Promise<WorkspaceFileRenameResult>;
  applyCreateResult(result: WorkspaceFileCreateResult): void;
  applyDeleteResult(result: WorkspaceFileDeleteResult): void;
  applyRenameResult(result: WorkspaceFileRenameResult): void;
  applyWatchEvent(event: WorkspaceFileWatchEvent): void;
  applyGitBadge(path: string, badge: WorkspaceGitBadgeStatus | null): void;
  applyGitBadges(badges: readonly WorkspaceGitBadge[]): void;
  applyGitBadgesResult(result: WorkspaceGitBadgesReadResult): void;
  getSelectedNode(): WorkspaceFileTreeNode | null;
  getVisibleNodes(): FilesVisibleTreeNode[];
}

export type FilesServiceStore = StoreApi<IFilesService>;
export type FilesServiceState = Pick<
  IFilesService,
  | "fileTree"
  | "workspaceId"
  | "rootPath"
  | "nodes"
  | "loading"
  | "errorMessage"
  | "readAt"
  | "refreshRequested"
  | "refreshReason"
  | "lastWatchEvent"
  | "selectedPath"
  | "expandedPaths"
  | "pendingExplorerEdit"
  | "pendingExplorerDelete"
  | "expandedPathsByWorkspace"
  | "selectedPathByWorkspace"
  | "pendingExplorerEditsByWorkspace"
  | "pendingExplorerDeletesByWorkspace"
  | "gitBadgeByPath"
>;

const EMPTY_FILE_TREE: FilesFileTreeState = {
  workspaceId: null,
  rootPath: "",
  nodes: [],
  loading: false,
  errorMessage: null,
  readAt: null,
};

const DEFAULT_FILES_STATE: FilesServiceState = {
  fileTree: EMPTY_FILE_TREE,
  workspaceId: null,
  rootPath: null,
  nodes: [],
  loading: false,
  errorMessage: null,
  readAt: null,
  refreshRequested: false,
  refreshReason: null,
  lastWatchEvent: null,
  selectedPath: null,
  expandedPaths: {},
  pendingExplorerEdit: null,
  pendingExplorerDelete: null,
  expandedPathsByWorkspace: {},
  selectedPathByWorkspace: {},
  pendingExplorerEditsByWorkspace: {},
  pendingExplorerDeletesByWorkspace: {},
  gitBadgeByPath: {},
};

const UNAVAILABLE_FILES_BRIDGE: EditorBridge = {
  async invoke<TRequest extends EditorBridgeRequest>(
    request: TRequest,
  ): Promise<EditorBridgeResultFor<TRequest>> {
    throw new Error(`Files service bridge is unavailable for ${request.type}.`);
  },
};

export function createFilesService(initialState?: Partial<FilesServiceState>): FilesServiceStore;
export function createFilesService(
  bridge: EditorBridge,
  initialState?: Partial<FilesServiceState>,
): FilesServiceStore;
export function createFilesService(
  bridgeOrInitialState: EditorBridge | Partial<FilesServiceState> = {},
  maybeInitialState: Partial<FilesServiceState> = {},
): FilesServiceStore {
  const bridge = isEditorBridge(bridgeOrInitialState) ? bridgeOrInitialState : UNAVAILABLE_FILES_BRIDGE;
  const initialState = isEditorBridge(bridgeOrInitialState) ? maybeInitialState : bridgeOrInitialState;
  const initial = normalizeInitialFilesState(initialState);
  return createStore<IFilesService>((set, get) => ({
    ...initial,
    setActiveWorkspace(workspaceId) {
      set((state) => {
        if (!workspaceId) {
          return {
            workspaceId: null,
            rootPath: null,
            nodes: [],
            loading: false,
            errorMessage: null,
            readAt: null,
            fileTree: EMPTY_FILE_TREE,
            selectedPath: null,
            expandedPaths: {},
            pendingExplorerEdit: null,
            pendingExplorerDelete: null,
            gitBadgeByPath: {},
          };
        }

        return {
          workspaceId,
          rootPath: state.workspaceId === workspaceId ? state.rootPath : null,
          nodes: state.workspaceId === workspaceId ? state.nodes : [],
          loading: false,
          errorMessage: null,
          readAt: state.workspaceId === workspaceId ? state.readAt : null,
          fileTree: createFileTreeState({
            workspaceId,
            rootPath: state.workspaceId === workspaceId ? state.rootPath : null,
            nodes: state.workspaceId === workspaceId ? state.nodes : [],
            loading: false,
            errorMessage: null,
            readAt: state.workspaceId === workspaceId ? state.readAt : null,
          }),
          ...deriveActiveExplorerState(
            workspaceId,
            state.expandedPathsByWorkspace,
            state.selectedPathByWorkspace,
            state.pendingExplorerEditsByWorkspace,
            state.pendingExplorerDeletesByWorkspace,
          ),
          gitBadgeByPath: state.workspaceId === workspaceId ? state.gitBadgeByPath : {},
        };
      });
    },
    beginRefresh(workspaceId, rootPath = get().rootPath) {
      set((state) => ({
        workspaceId,
        rootPath: rootPath ?? get().rootPath,
        loading: true,
        errorMessage: null,
        refreshRequested: false,
        refreshReason: null,
        fileTree: createFileTreeState({
          workspaceId,
          rootPath: rootPath ?? get().rootPath,
          nodes: state.nodes,
          loading: true,
          errorMessage: null,
          readAt: state.readAt,
        }),
      }));
    },
    async refreshFileTree(workspaceId = get().workspaceId) {
      if (!workspaceId) {
        set({
          workspaceId: null,
          rootPath: null,
          nodes: [],
          loading: false,
          errorMessage: null,
          readAt: null,
          fileTree: EMPTY_FILE_TREE,
          selectedPath: null,
          expandedPaths: {},
          pendingExplorerEdit: null,
          pendingExplorerDelete: null,
          gitBadgeByPath: {},
        });
        return null;
      }

      get().beginRefresh(workspaceId, null);

      try {
        const result = await bridge.invoke({
          type: "workspace-files/tree/read",
          workspaceId,
          rootPath: null,
        });
        get().applyTreeReadResult(result);
        return result;
      } catch (error) {
        get().setError(errorMessage(error, "Unable to read files."));
        return null;
      }
    },
    markRefreshRequested(reason) {
      set({ refreshRequested: true, refreshReason: reason });
    },
    clearRefreshRequest() {
      set({ refreshRequested: false, refreshReason: null });
    },
    setTree(snapshot) {
      set({
        workspaceId: snapshot.workspaceId,
        rootPath: snapshot.rootPath,
        nodes: snapshot.nodes,
        loading: false,
        errorMessage: null,
        readAt: snapshot.readAt ?? null,
        refreshRequested: false,
        refreshReason: null,
        fileTree: createFileTreeState({
          workspaceId: snapshot.workspaceId,
          rootPath: snapshot.rootPath,
          nodes: snapshot.nodes,
          loading: false,
          errorMessage: null,
          readAt: snapshot.readAt ?? null,
        }),
        gitBadgeByPath: collectGitBadges(snapshot.nodes),
      });
    },
    applyTreeReadResult(result) {
      set({
        workspaceId: result.workspaceId,
        rootPath: result.rootPath,
        nodes: result.nodes,
        loading: false,
        errorMessage: null,
        readAt: result.readAt,
        refreshRequested: false,
        refreshReason: null,
        fileTree: createFileTreeState({
          workspaceId: result.workspaceId,
          rootPath: result.rootPath,
          nodes: result.nodes,
          loading: false,
          errorMessage: null,
          readAt: result.readAt,
        }),
        gitBadgeByPath: collectGitBadges(result.nodes),
      });
    },
    setLoading(loading) {
      set((state) => ({
        loading,
        fileTree: createFileTreeState({ ...state, loading }),
      }));
    },
    setError(errorMessage) {
      set((state) => ({
        errorMessage,
        loading: false,
        fileTree: createFileTreeState({ ...state, errorMessage, loading: false }),
      }));
    },
    selectPath(path) {
      set((state) => {
        const workspaceId = resolveExplorerWorkspaceId(state);
        if (!workspaceId) {
          return { selectedPath: path };
        }

        return applyWorkspaceExplorerChanges(state, workspaceId, {
          selectedPath: path,
          expandedPaths: path ? expandAncestorPaths(expandedPathsForWorkspace(state, workspaceId), path) : undefined,
        });
      });
    },
    toggleDirectory(path) {
      set((state) => {
        const workspaceId = resolveExplorerWorkspaceId(state);
        if (!workspaceId) {
          return state;
        }
        const expandedPaths = { ...state.expandedPaths };
        if (expandedPaths[path]) {
          delete expandedPaths[path];
        } else {
          expandedPaths[path] = true;
        }

        return applyWorkspaceExplorerChanges(state, workspaceId, { expandedPaths });
      });
    },
    expandDirectory(path) {
      set((state) => {
        const workspaceId = resolveExplorerWorkspaceId(state);
        if (!workspaceId) {
          return state;
        }
        return applyWorkspaceExplorerChanges(state, workspaceId, {
          expandedPaths: {
            ...expandedPathsForWorkspace(state, workspaceId),
            [path]: true,
          },
        });
      });
    },
    collapseDirectory(path) {
      set((state) => {
        const workspaceId = resolveExplorerWorkspaceId(state);
        if (!workspaceId) {
          return state;
        }
        return applyWorkspaceExplorerChanges(state, workspaceId, {
          expandedPaths: removeExpandedPathDescendants(expandedPathsForWorkspace(state, workspaceId), path),
        });
      });
    },
    collapseAll() {
      set((state) => {
        const workspaceId = resolveExplorerWorkspaceId(state);
        if (!workspaceId) {
          return { expandedPaths: {} };
        }
        return applyWorkspaceExplorerChanges(state, workspaceId, { expandedPaths: {} });
      });
    },
    expandAncestors(path) {
      set((state) => {
        const workspaceId = resolveExplorerWorkspaceId(state);
        if (!workspaceId) {
          return state;
        }
        return applyWorkspaceExplorerChanges(state, workspaceId, {
          expandedPaths: expandAncestorPaths(expandedPathsForWorkspace(state, workspaceId), path),
        });
      });
    },
    beginCreateFile(parentPath, workspaceId = get().workspaceId) {
      beginCreateExplorerNode(set, get, "file", parentPath, workspaceId);
    },
    beginCreateFolder(parentPath, workspaceId = get().workspaceId) {
      beginCreateExplorerNode(set, get, "directory", parentPath, workspaceId);
    },
    beginRename(path, kind, workspaceId = get().workspaceId) {
      const resolvedWorkspaceId = workspaceId ?? get().workspaceId;
      if (!resolvedWorkspaceId) {
        return;
      }

      set((state) => ({
        ...applyWorkspaceExplorerChanges(state, resolvedWorkspaceId, {
          expandedPaths: expandAncestorPaths(expandedPathsForWorkspace(state, resolvedWorkspaceId), path),
          selectedPath: path,
          pendingExplorerEdit: {
            type: "rename",
            workspaceId: resolvedWorkspaceId,
            path,
            kind,
          },
          pendingExplorerDelete: null,
        }),
      }));
    },
    beginDelete(path, kind, workspaceId = get().workspaceId) {
      const resolvedWorkspaceId = workspaceId ?? get().workspaceId;
      if (!resolvedWorkspaceId) {
        return;
      }

      set((state) => ({
        ...applyWorkspaceExplorerChanges(state, resolvedWorkspaceId, {
          expandedPaths: expandAncestorPaths(expandedPathsForWorkspace(state, resolvedWorkspaceId), path),
          selectedPath: path,
          pendingExplorerEdit: null,
          pendingExplorerDelete: {
            workspaceId: resolvedWorkspaceId,
            path,
            kind,
          },
        }),
      }));
    },
    cancelExplorerEdit() {
      set((state) => {
        const workspaceId = resolveExplorerWorkspaceId(state);
        if (!workspaceId) {
          return { pendingExplorerEdit: null, pendingExplorerDelete: null };
        }
        return applyWorkspaceExplorerChanges(state, workspaceId, {
          pendingExplorerEdit: null,
          pendingExplorerDelete: null,
        });
      });
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
      get().applyCreateResult(result);
      await get().refreshFileTree(workspaceId);
      return result;
    },
    async deleteFileNode(workspaceId, path, kind) {
      const result = await bridge.invoke({
        type: "workspace-files/file/delete",
        workspaceId,
        path,
        recursive: kind === "directory",
      });
      get().applyDeleteResult(result);
      await get().refreshFileTree(workspaceId);
      return result;
    },
    async renameFileNode(workspaceId, oldPath, newPath) {
      const result = await bridge.invoke({
        type: "workspace-files/file/rename",
        workspaceId,
        oldPath,
        newPath,
      });
      get().applyRenameResult(result);
      await get().refreshFileTree(workspaceId);
      return result;
    },
    applyCreateResult(result) {
      set((state) => {
        if (!shouldApplyWorkspaceResult(state.workspaceId, result.workspaceId)) {
          return state;
        }

        const expandedPaths = expandAncestorPaths(state.expandedPaths, result.path);
        if (result.kind === "directory") {
          expandedPaths[result.path] = true;
        }

        return {
          workspaceId: result.workspaceId,
          nodes: insertCreatedNode(state.nodes, result),
          fileTree: createFileTreeState({
            ...state,
            workspaceId: result.workspaceId,
            nodes: insertCreatedNode(state.nodes, result),
          }),
          ...applyWorkspaceExplorerChanges(state, result.workspaceId, {
            selectedPath: result.path,
            expandedPaths,
            pendingExplorerEdit: null,
            pendingExplorerDelete: null,
          }),
          refreshRequested: true,
          refreshReason: "crud" as const,
        };
      });
    },
    applyDeleteResult(result) {
      set((state) => {
        if (!shouldApplyWorkspaceResult(state.workspaceId, result.workspaceId)) {
          return state;
        }

        return {
          workspaceId: result.workspaceId,
          nodes: removeTreeNode(state.nodes, result.path),
          fileTree: createFileTreeState({
            ...state,
            workspaceId: result.workspaceId,
            nodes: removeTreeNode(state.nodes, result.path),
          }),
          ...applyWorkspaceExplorerChanges(state, result.workspaceId, {
            expandedPaths: removeExpandedPathDescendants(state.expandedPaths, result.path),
            selectedPath: state.selectedPath && isPathOrDescendant(state.selectedPath, result.path)
              ? null
              : state.selectedPath,
            pendingExplorerEdit: clearPendingEditForPath(state.pendingExplorerEdit, result.path),
            pendingExplorerDelete:
              state.pendingExplorerDelete && isPathOrDescendant(state.pendingExplorerDelete.path, result.path)
                ? null
                : state.pendingExplorerDelete,
          }),
          gitBadgeByPath: removeRecordPathDescendants(state.gitBadgeByPath, result.path),
          refreshRequested: true,
          refreshReason: "crud" as const,
        };
      });
    },
    applyRenameResult(result) {
      set((state) => {
        if (!shouldApplyWorkspaceResult(state.workspaceId, result.workspaceId)) {
          return state;
        }

        return {
          workspaceId: result.workspaceId,
          nodes: renameTreePath(state.nodes, result.oldPath, result.newPath),
          fileTree: createFileTreeState({
            ...state,
            workspaceId: result.workspaceId,
            nodes: renameTreePath(state.nodes, result.oldPath, result.newPath),
          }),
          ...applyWorkspaceExplorerChanges(state, result.workspaceId, {
            expandedPaths: rewriteRecordPaths(state.expandedPaths, result.oldPath, result.newPath),
            selectedPath: state.selectedPath && isPathOrDescendant(state.selectedPath, result.oldPath)
              ? rewritePathPrefix(state.selectedPath, result.oldPath, result.newPath)
              : state.selectedPath,
            pendingExplorerEdit: null,
            pendingExplorerDelete: null,
          }),
          gitBadgeByPath: rewriteRecordPaths(state.gitBadgeByPath, result.oldPath, result.newPath),
          refreshRequested: true,
          refreshReason: "crud" as const,
        };
      });
    },
    applyWatchEvent(event) {
      set((state) => {
        if (!shouldApplyWorkspaceResult(state.workspaceId, event.workspaceId)) {
          return state;
        }

        const base = {
          workspaceId: event.workspaceId,
          lastWatchEvent: event,
          refreshRequested: true,
          refreshReason: "watch" as const,
        };

        if (event.change === "deleted") {
          const nodes = removeTreeNode(state.nodes, event.path);
          return {
            ...base,
            nodes,
            fileTree: createFileTreeState({ ...state, workspaceId: event.workspaceId, nodes }),
            ...applyWorkspaceExplorerChanges(state, event.workspaceId, {
              expandedPaths: removeExpandedPathDescendants(state.expandedPaths, event.path),
              selectedPath: state.selectedPath && isPathOrDescendant(state.selectedPath, event.path)
                ? null
                : state.selectedPath,
              pendingExplorerEdit: clearPendingEditForPath(state.pendingExplorerEdit, event.path),
              pendingExplorerDelete:
                state.pendingExplorerDelete && isPathOrDescendant(state.pendingExplorerDelete.path, event.path)
                  ? null
                  : state.pendingExplorerDelete,
            }),
            gitBadgeByPath: removeRecordPathDescendants(state.gitBadgeByPath, event.path),
          };
        }

        if (event.change === "renamed" && event.oldPath) {
          const nodes = renameTreePath(state.nodes, event.oldPath, event.path);
          return {
            ...base,
            nodes,
            fileTree: createFileTreeState({ ...state, workspaceId: event.workspaceId, nodes }),
            ...applyWorkspaceExplorerChanges(state, event.workspaceId, {
              expandedPaths: rewriteRecordPaths(state.expandedPaths, event.oldPath, event.path),
              selectedPath: state.selectedPath && isPathOrDescendant(state.selectedPath, event.oldPath)
                ? rewritePathPrefix(state.selectedPath, event.oldPath, event.path)
                : state.selectedPath,
              pendingExplorerEdit: null,
              pendingExplorerDelete: null,
            }),
            gitBadgeByPath: rewriteRecordPaths(state.gitBadgeByPath, event.oldPath, event.path),
          };
        }

        return base;
      });
    },
    applyGitBadge(path, badge) {
      set((state) => ({
        gitBadgeByPath: applyGitBadgeToRecord(state.gitBadgeByPath, path, badge),
      }));
    },
    applyGitBadges(badges) {
      set((state) => ({
        gitBadgeByPath: badges.reduce(
          (gitBadgeByPath, badge) => applyGitBadgeToRecord(gitBadgeByPath, badge.path, badge.status),
          state.gitBadgeByPath,
        ),
      }));
    },
    applyGitBadgesResult(result) {
      set((state) => {
        if (!shouldApplyWorkspaceResult(state.workspaceId, result.workspaceId)) {
          return state;
        }

        return {
          workspaceId: result.workspaceId,
          gitBadgeByPath: result.badges.reduce(
            (gitBadgeByPath, badge) => applyGitBadgeToRecord(gitBadgeByPath, badge.path, badge.status),
            state.gitBadgeByPath,
          ),
        };
      });
    },
    getSelectedNode() {
      const state = get();
      return state.selectedPath ? findNodeByPath(state.nodes, state.selectedPath) : null;
    },
    getVisibleNodes() {
      const state = get();
      return flattenVisibleFileTree(state.nodes, state.expandedPaths);
    },
  }));
}

function normalizeInitialFilesState(initialState: Partial<FilesServiceState>): FilesServiceState {
  const merged = {
    ...DEFAULT_FILES_STATE,
    ...initialState,
    expandedPathsByWorkspace: {
      ...DEFAULT_FILES_STATE.expandedPathsByWorkspace,
      ...initialState.expandedPathsByWorkspace,
    },
    selectedPathByWorkspace: {
      ...DEFAULT_FILES_STATE.selectedPathByWorkspace,
      ...initialState.selectedPathByWorkspace,
    },
    pendingExplorerEditsByWorkspace: {
      ...DEFAULT_FILES_STATE.pendingExplorerEditsByWorkspace,
      ...initialState.pendingExplorerEditsByWorkspace,
    },
    pendingExplorerDeletesByWorkspace: {
      ...DEFAULT_FILES_STATE.pendingExplorerDeletesByWorkspace,
      ...initialState.pendingExplorerDeletesByWorkspace,
    },
  };

  return {
    ...merged,
    fileTree: initialState.fileTree ?? createFileTreeState(merged),
  };
}

function createFileTreeState(
  state: Pick<
    IFilesService,
    "workspaceId" | "rootPath" | "nodes" | "loading" | "errorMessage" | "readAt"
  >,
): FilesFileTreeState {
  return {
    workspaceId: state.workspaceId,
    rootPath: state.rootPath ?? "",
    nodes: state.nodes,
    loading: state.loading,
    errorMessage: state.errorMessage,
    readAt: state.readAt,
  };
}

function isEditorBridge(value: unknown): value is EditorBridge {
  return typeof value === "object" && value !== null && "invoke" in value;
}

interface WorkspaceExplorerChanges {
  expandedPaths?: Record<string, true>;
  selectedPath?: string | null;
  pendingExplorerEdit?: FilesPendingExplorerEdit | null;
  pendingExplorerDelete?: FilesPendingExplorerDelete | null;
}

function applyWorkspaceExplorerChanges(
  state: IFilesService,
  workspaceId: WorkspaceId,
  changes: WorkspaceExplorerChanges,
): Partial<IFilesService> {
  const expandedPathsByWorkspace =
    changes.expandedPaths === undefined
      ? state.expandedPathsByWorkspace
      : {
          ...state.expandedPathsByWorkspace,
          [workspaceId]: changes.expandedPaths,
        };
  const selectedPathByWorkspace =
    changes.selectedPath === undefined
      ? state.selectedPathByWorkspace
      : setNullableWorkspaceRecordValue(state.selectedPathByWorkspace, workspaceId, changes.selectedPath);
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
    selectedPathByWorkspace,
    pendingExplorerEditsByWorkspace,
    pendingExplorerDeletesByWorkspace,
    ...deriveActiveExplorerState(
      state.workspaceId,
      expandedPathsByWorkspace,
      selectedPathByWorkspace,
      pendingExplorerEditsByWorkspace,
      pendingExplorerDeletesByWorkspace,
    ),
  };
}

function deriveActiveExplorerState(
  activeWorkspaceId: WorkspaceId | null,
  expandedPathsByWorkspace: Record<string, Record<string, true>>,
  selectedPathByWorkspace: Record<string, string>,
  pendingExplorerEditsByWorkspace: Record<string, FilesPendingExplorerEdit>,
  pendingExplorerDeletesByWorkspace: Record<string, FilesPendingExplorerDelete>,
): Pick<IFilesService, "expandedPaths" | "selectedPath" | "pendingExplorerEdit" | "pendingExplorerDelete"> {
  if (!activeWorkspaceId) {
    return {
      expandedPaths: {},
      selectedPath: null,
      pendingExplorerEdit: null,
      pendingExplorerDelete: null,
    };
  }

  return {
    expandedPaths: expandedPathsByWorkspace[activeWorkspaceId] ?? {},
    selectedPath: selectedPathByWorkspace[activeWorkspaceId] ?? null,
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
  state: Pick<IFilesService, "workspaceId" | "fileTree">,
  workspaceId: WorkspaceId | null | undefined = state.workspaceId,
): WorkspaceId | null {
  return workspaceId ?? state.workspaceId ?? state.fileTree.workspaceId;
}

function expandedPathsForWorkspace(
  state: Pick<IFilesService, "expandedPathsByWorkspace" | "expandedPaths">,
  workspaceId: WorkspaceId,
): Record<string, true> {
  return state.expandedPathsByWorkspace[workspaceId] ?? state.expandedPaths;
}

function moveTreeSelectionInState(
  state: IFilesService,
  movement: FilesTreeSelectionMovement,
): Partial<IFilesService> | IFilesService {
  const workspaceId = resolveExplorerWorkspaceId(state);
  if (!workspaceId) {
    return state;
  }

  const expandedPaths = expandedPathsForWorkspace(state, workspaceId);
  const visibleNodes = flattenVisibleFileTree(state.nodes, expandedPaths);
  if (visibleNodes.length === 0) {
    return state;
  }

  const selectedPath = state.selectedPathByWorkspace[workspaceId] ?? null;
  const selectedIndex = selectedPath
    ? visibleNodes.findIndex((visibleNode) => visibleNode.path === selectedPath)
    : -1;
  const selectedVisibleNode = selectedIndex >= 0 ? visibleNodes[selectedIndex] : null;

  if (movement === "first") {
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedPath: visibleNodes[0]?.path ?? null,
    });
  }

  if (movement === "last") {
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedPath: visibleNodes.at(-1)?.path ?? null,
    });
  }

  if (movement === "next") {
    const nextNode =
      selectedIndex < 0
        ? visibleNodes[0]
        : visibleNodes[Math.min(selectedIndex + 1, visibleNodes.length - 1)];
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedPath: nextNode?.path ?? null,
    });
  }

  if (movement === "previous") {
    const previousNode =
      selectedIndex < 0
        ? visibleNodes.at(-1)
        : visibleNodes[Math.max(selectedIndex - 1, 0)];
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedPath: previousNode?.path ?? null,
    });
  }

  if (!selectedVisibleNode) {
    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedPath: visibleNodes[0]?.path ?? null,
    });
  }

  if (movement === "parent") {
    if (selectedVisibleNode.kind === "directory" && expandedPaths[selectedVisibleNode.path]) {
      const nextExpandedPaths = { ...expandedPaths };
      delete nextExpandedPaths[selectedVisibleNode.path];
      return applyWorkspaceExplorerChanges(state, workspaceId, {
        expandedPaths: nextExpandedPaths,
      });
    }

    return applyWorkspaceExplorerChanges(state, workspaceId, {
      selectedPath: selectedVisibleNode.parentPath ?? selectedVisibleNode.path,
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
    selectedPath: firstChild?.path ?? selectedVisibleNode.path,
  });
}

function shouldApplyWorkspaceResult(
  currentWorkspaceId: WorkspaceId | null,
  incomingWorkspaceId: WorkspaceId,
): boolean {
  return currentWorkspaceId === null || currentWorkspaceId === incomingWorkspaceId;
}

function beginCreateExplorerNode(
  set: FilesServiceStore["setState"],
  get: FilesServiceStore["getState"],
  kind: WorkspaceFileKind,
  parentPath: string | null | undefined,
  workspaceId: WorkspaceId | null | undefined,
): void {
  const resolvedWorkspaceId = workspaceId ?? get().workspaceId;
  if (!resolvedWorkspaceId) {
    return;
  }

  set((state) => {
    const resolvedParentPath = parentPath === undefined ? inferCreateParentPath(state) : parentPath;
    const expandedPathsForActiveWorkspace = expandedPathsForWorkspace(state, resolvedWorkspaceId);
    const expandedPaths = resolvedParentPath
      ? expandAncestorPaths(
          {
            ...expandedPathsForActiveWorkspace,
            [resolvedParentPath]: true,
          },
          resolvedParentPath,
        )
      : expandedPathsForActiveWorkspace;

    return applyWorkspaceExplorerChanges(state, resolvedWorkspaceId, {
      expandedPaths,
      selectedPath: resolvedParentPath,
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

function findNodeByPath(nodes: readonly WorkspaceFileTreeNode[], path: string): WorkspaceFileTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }

    const child = findNodeByPath(node.children ?? [], path);
    if (child) {
      return child;
    }
  }

  return null;
}

function flattenVisibleFileTree(
  nodes: readonly WorkspaceFileTreeNode[],
  expandedPaths: Record<string, true>,
): FilesVisibleTreeNode[] {
  const visibleNodes: FilesVisibleTreeNode[] = [];

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

function applyGitBadgeToRecord(
  record: Record<string, WorkspaceGitBadgeStatus>,
  path: string,
  badge: WorkspaceGitBadgeStatus | null,
): Record<string, WorkspaceGitBadgeStatus> {
  const gitBadgeByPath = { ...record };
  if (badge === null || badge === "clean") {
    delete gitBadgeByPath[path];
  } else {
    gitBadgeByPath[path] = badge;
  }

  return gitBadgeByPath;
}

function insertCreatedNode(
  nodes: readonly WorkspaceFileTreeNode[],
  result: WorkspaceFileCreateResult,
): WorkspaceFileTreeNode[] {
  const newNode = createNodeFromResult(result);
  return upsertTreeNode(nodes, parentPathFor(result.path), newNode);
}

function createNodeFromResult(result: WorkspaceFileCreateResult): WorkspaceFileTreeNode {
  const base = {
    name: nameForPath(result.path),
    path: result.path,
    kind: result.kind,
  } satisfies WorkspaceFileTreeNode;

  return result.kind === "directory" ? { ...base, children: [] } : base;
}

function upsertTreeNode(
  nodes: readonly WorkspaceFileTreeNode[],
  parentPath: string | null,
  nodeToUpsert: WorkspaceFileTreeNode,
): WorkspaceFileTreeNode[] {
  if (parentPath === null) {
    return upsertSiblingNode(nodes, nodeToUpsert);
  }

  return nodes.map((node) => {
    if (node.path === parentPath && node.kind === "directory") {
      return {
        ...node,
        children: upsertSiblingNode(node.children ?? [], nodeToUpsert),
      };
    }

    if (!node.children) {
      return node;
    }

    return {
      ...node,
      children: upsertTreeNode(node.children, parentPath, nodeToUpsert),
    };
  });
}

function upsertSiblingNode(
  nodes: readonly WorkspaceFileTreeNode[],
  nodeToUpsert: WorkspaceFileTreeNode,
): WorkspaceFileTreeNode[] {
  if (nodes.some((node) => node.path === nodeToUpsert.path)) {
    return nodes.map((node) => node.path === nodeToUpsert.path ? nodeToUpsert : node);
  }

  return [...nodes, nodeToUpsert];
}

function removeTreeNode(
  nodes: readonly WorkspaceFileTreeNode[],
  path: string,
): WorkspaceFileTreeNode[] {
  return nodes
    .filter((node) => !isPathOrDescendant(node.path, path))
    .map((node) => node.children
      ? {
          ...node,
          children: removeTreeNode(node.children, path),
        }
      : node);
}

function renameTreePath(
  nodes: readonly WorkspaceFileTreeNode[],
  oldPath: string,
  newPath: string,
): WorkspaceFileTreeNode[] {
  return nodes.map((node) => {
    const rewrittenPath = rewritePathPrefix(node.path, oldPath, newPath);
    return {
      ...node,
      path: rewrittenPath,
      name: rewrittenPath === node.path ? node.name : nameForPath(rewrittenPath),
      children: node.children ? renameTreePath(node.children, oldPath, newPath) : node.children,
    };
  });
}

function inferCreateParentPath(state: Pick<IFilesService, "nodes" | "selectedPath">): string | null {
  if (!state.selectedPath) {
    return null;
  }

  const selectedNode = findNodeByPath(state.nodes, state.selectedPath);
  return selectedNode?.kind === "directory" ? state.selectedPath : parentPathFor(state.selectedPath);
}

function clearPendingEditForPath(
  pendingEdit: FilesPendingExplorerEdit | null,
  path: string,
): FilesPendingExplorerEdit | null {
  if (!pendingEdit) {
    return null;
  }

  if (pendingEdit.type === "rename") {
    return isPathOrDescendant(pendingEdit.path, path) ? null : pendingEdit;
  }

  return pendingEdit.parentPath && isPathOrDescendant(pendingEdit.parentPath, path)
    ? null
    : pendingEdit;
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

function nameForPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
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

function rewriteRecordPaths<TValue>(
  record: Record<string, TValue>,
  oldPath: string,
  newPath: string,
): Record<string, TValue> {
  const nextRecord: Record<string, TValue> = {};
  for (const [path, value] of Object.entries(record)) {
    nextRecord[rewritePathPrefix(path, oldPath, newPath)] = value;
  }
  return nextRecord;
}

function removeRecordPathDescendants<TValue>(
  record: Record<string, TValue>,
  deletedPath: string,
): Record<string, TValue> {
  const nextRecord: Record<string, TValue> = {};
  for (const [path, value] of Object.entries(record)) {
    if (!isPathOrDescendant(path, deletedPath)) {
      nextRecord[path] = value;
    }
  }
  return nextRecord;
}

function removeExpandedPathDescendants(
  expandedPaths: Record<string, true>,
  deletedPath: string,
): Record<string, true> {
  return removeRecordPathDescendants(expandedPaths, deletedPath);
}

export type { WorkspaceFileKind };
