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

  ensureRoot(workspaceId: string, rootAbsPath: string): Promise<void>;
  toggleExpand(workspaceId: string, absPath: string): Promise<void>;
  loadChildren(workspaceId: string, absPath: string): Promise<void>;
  refresh(workspaceId: string, absPath?: string): Promise<void>;
  reveal(workspaceId: string, absPath: string): Promise<void>;
}
