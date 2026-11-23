import type { DirEntry } from "../../../../shared/fs/types";

export interface TreeNode {
  absPath: string;
  name: string;
  type: "file" | "dir" | "symlink";
  childrenLoaded: boolean;
  children: string[];
}

export interface WorkspaceTree {
  rootAbsPath: string;
  nodes: Map<string, TreeNode>;
  expanded: Set<string>;
  loading: Set<string>;
  errors: Map<string, string>;
}

export type FlatItem = { absPath: string; node: TreeNode; depth: number };

export interface PendingRenameRequest {
  absPath: string;
  requestId: number;
}

export interface FileSelection {
  focus: string | null;
  anchor: string | null;
  paths: Set<string>;
}

export interface FilesState {
  trees: Map<string, WorkspaceTree>;
  selection: Map<string, FileSelection>;
  pendingRenameRequest: PendingRenameRequest | null;

  requestRename(absPath: string): void;

  setSingleSelection(workspaceId: string, path: string): void;
  toggleSelection(workspaceId: string, path: string): void;
  extendSelectionTo(workspaceId: string, target: string, flatPaths: readonly string[]): void;
  selectAllVisible(workspaceId: string, flatPaths: readonly string[]): void;
  selectAllVisibleHierarchical(
    workspaceId: string,
    flatPaths: readonly string[],
    rootAbsPath: string,
  ): void;
  clearToFocus(workspaceId: string): void;
  setFocus(workspaceId: string, path: string): void;
  clearSelection(workspaceId: string): void;

  initTree(workspaceId: string, rootAbsPath: string, persistedRelPaths: string[]): void;
  markChildrenLoading(workspaceId: string, absPath: string): void;
  setChildren(workspaceId: string, absPath: string, entries: DirEntry[]): void;
  setChildrenError(workspaceId: string, absPath: string, message: string): void;
  expandDir(workspaceId: string, absPath: string): void;
  collapseDir(workspaceId: string, absPath: string): void;
  markChildrenStale(workspaceId: string, absPath: string): void;
  wipeSubtree(workspaceId: string, targetPath: string): void;
  closeAllForWorkspace(workspaceId: string): void;
}
