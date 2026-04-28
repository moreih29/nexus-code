import { createStore, type StoreApi } from "zustand/vanilla";

import type {
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

export type FilesRefreshReason = "manual" | "watch" | "crud";

export interface FilesTreeSnapshot {
  workspaceId: WorkspaceId;
  rootPath: string;
  nodes: WorkspaceFileTreeNode[];
  readAt?: string | null;
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
  gitBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  beginRefresh(workspaceId: WorkspaceId, rootPath?: string | null): void;
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
  | "gitBadgeByPath"
>;

const DEFAULT_FILES_STATE: FilesServiceState = {
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
  gitBadgeByPath: {},
};

export function createFilesService(
  initialState: Partial<FilesServiceState> = {},
): FilesServiceStore {
  return createStore<IFilesService>((set, get) => ({
    ...DEFAULT_FILES_STATE,
    ...initialState,
    beginRefresh(workspaceId, rootPath = get().rootPath) {
      set({
        workspaceId,
        rootPath: rootPath ?? get().rootPath,
        loading: true,
        errorMessage: null,
        refreshRequested: false,
        refreshReason: null,
      });
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
        gitBadgeByPath: collectGitBadges(result.nodes),
      });
    },
    setLoading(loading) {
      set({ loading });
    },
    setError(errorMessage) {
      set({ errorMessage, loading: false });
    },
    selectPath(path) {
      set({ selectedPath: path });
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
    expandDirectory(path) {
      set((state) => ({
        expandedPaths: {
          ...state.expandedPaths,
          [path]: true,
        },
      }));
    },
    collapseDirectory(path) {
      set((state) => ({
        expandedPaths: removeExpandedPathDescendants(state.expandedPaths, path),
      }));
    },
    collapseAll() {
      set({ expandedPaths: {} });
    },
    expandAncestors(path) {
      set((state) => ({
        expandedPaths: expandAncestorPaths(state.expandedPaths, path),
      }));
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
        expandedPaths: expandAncestorPaths(state.expandedPaths, path),
        selectedPath: path,
        pendingExplorerEdit: {
          type: "rename",
          workspaceId: resolvedWorkspaceId,
          path,
          kind,
        },
        pendingExplorerDelete: null,
      }));
    },
    beginDelete(path, kind, workspaceId = get().workspaceId) {
      const resolvedWorkspaceId = workspaceId ?? get().workspaceId;
      if (!resolvedWorkspaceId) {
        return;
      }

      set((state) => ({
        expandedPaths: expandAncestorPaths(state.expandedPaths, path),
        selectedPath: path,
        pendingExplorerEdit: null,
        pendingExplorerDelete: {
          workspaceId: resolvedWorkspaceId,
          path,
          kind,
        },
      }));
    },
    cancelExplorerEdit() {
      set({ pendingExplorerEdit: null, pendingExplorerDelete: null });
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
          selectedPath: result.path,
          expandedPaths,
          pendingExplorerEdit: null,
          pendingExplorerDelete: null,
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
          expandedPaths: removeExpandedPathDescendants(state.expandedPaths, result.path),
          selectedPath: state.selectedPath && isPathOrDescendant(state.selectedPath, result.path)
            ? null
            : state.selectedPath,
          pendingExplorerEdit: clearPendingEditForPath(state.pendingExplorerEdit, result.path),
          pendingExplorerDelete:
            state.pendingExplorerDelete && isPathOrDescendant(state.pendingExplorerDelete.path, result.path)
              ? null
              : state.pendingExplorerDelete,
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
          expandedPaths: rewriteRecordPaths(state.expandedPaths, result.oldPath, result.newPath),
          selectedPath: state.selectedPath && isPathOrDescendant(state.selectedPath, result.oldPath)
            ? rewritePathPrefix(state.selectedPath, result.oldPath, result.newPath)
            : state.selectedPath,
          pendingExplorerEdit: null,
          pendingExplorerDelete: null,
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
          return {
            ...base,
            nodes: removeTreeNode(state.nodes, event.path),
            expandedPaths: removeExpandedPathDescendants(state.expandedPaths, event.path),
            selectedPath: state.selectedPath && isPathOrDescendant(state.selectedPath, event.path)
              ? null
              : state.selectedPath,
            pendingExplorerEdit: clearPendingEditForPath(state.pendingExplorerEdit, event.path),
            pendingExplorerDelete:
              state.pendingExplorerDelete && isPathOrDescendant(state.pendingExplorerDelete.path, event.path)
                ? null
                : state.pendingExplorerDelete,
            gitBadgeByPath: removeRecordPathDescendants(state.gitBadgeByPath, event.path),
          };
        }

        if (event.change === "renamed" && event.oldPath) {
          return {
            ...base,
            nodes: renameTreePath(state.nodes, event.oldPath, event.path),
            expandedPaths: rewriteRecordPaths(state.expandedPaths, event.oldPath, event.path),
            selectedPath: state.selectedPath && isPathOrDescendant(state.selectedPath, event.oldPath)
              ? rewritePathPrefix(state.selectedPath, event.oldPath, event.path)
              : state.selectedPath,
            pendingExplorerEdit: null,
            pendingExplorerDelete: null,
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
    const expandedPaths = resolvedParentPath
      ? expandAncestorPaths(
          {
            ...state.expandedPaths,
            [resolvedParentPath]: true,
          },
          resolvedParentPath,
        )
      : state.expandedPaths;

    return {
      expandedPaths,
      selectedPath: resolvedParentPath,
      pendingExplorerEdit: {
        type: "create",
        workspaceId: resolvedWorkspaceId,
        parentPath: resolvedParentPath,
        kind,
      },
      pendingExplorerDelete: null,
    };
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
