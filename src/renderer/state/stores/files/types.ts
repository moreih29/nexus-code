import type { DirEntry } from "../../../../shared/fs/types";

export interface TreeNode {
  absPath: string;
  name: string;
  type: "file" | "dir" | "symlink";
  childrenLoaded: boolean;
  children: string[]; // absPath[]
}

export interface WorkspaceTree {
  rootAbsPath: string;
  nodes: Map<string, TreeNode>; // key = absPath
  expanded: Set<string>;
  loading: Set<string>;
  errors: Map<string, string>; // absPath → message
}

export type FlatItem = { absPath: string; node: TreeNode; depth: number };

export interface FilesState {
  trees: Map<string, WorkspaceTree>; // key = workspaceId
  activeAbsPath: Map<string, string | null>;

  setActiveAbsPath(workspaceId: string, absPath: string | null): void;

  // Pure reducers — no side effects
  initTree(workspaceId: string, rootAbsPath: string, persistedRelPaths: string[]): void;
  markChildrenLoading(workspaceId: string, absPath: string): void;
  setChildren(workspaceId: string, absPath: string, entries: DirEntry[]): void;
  setChildrenError(workspaceId: string, absPath: string, message: string): void;
  expandDir(workspaceId: string, absPath: string): void;
  collapseDir(workspaceId: string, absPath: string): void;
  /**
   * Bulk-set the expanded set to the union of its current contents and the
   * given absolute paths. Used by the "expand all (already loaded)" toolbar
   * action — operations layer is responsible for filtering to dirs whose
   * children are already in the cache.
   */
  expandMany(workspaceId: string, absPaths: readonly string[]): void;
  /**
   * Reset the expanded set to just the workspace root, leaving the cached
   * children intact so a subsequent expand of the same dir is instant.
   */
  collapseAll(workspaceId: string): void;
  markChildrenStale(workspaceId: string, absPath: string): void;
  wipeSubtree(workspaceId: string, targetPath: string): void;
  /**
   * Drop all workspace-keyed state for a removed workspace.
   * Mirrors the pattern in tabs / layout / model-cache stores: triggered by
   * the `workspace:removed` IPC event so a deleted workspace's tree nodes,
   * expanded set, and active-path entry don't linger in memory.
   */
  closeAllForWorkspace(workspaceId: string): void;
}
