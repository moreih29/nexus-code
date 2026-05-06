import type { DirEntry } from "../../../../shared/types/fs";

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
  markChildrenStale(workspaceId: string, absPath: string): void;
  wipeSubtree(workspaceId: string, targetPath: string): void;
}
