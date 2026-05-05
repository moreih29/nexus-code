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

  /**
   * Per-workspace mirror of the file-tree's currently-active row. The
   * tree component still owns its own `activeIndex` for arrow-key
   * navigation; this map is the surface that global handlers (notably
   * the `openToSide` keybinding, which fires from outside the tree's
   * local handler) read to find out which row to act on.
   *
   * `null` (or missing) means no row is active — typical after a
   * refresh that wipes the visible flat list.
   */
  activeAbsPath: Map<string, string | null>;

  ensureRoot(workspaceId: string, rootAbsPath: string): Promise<void>;
  toggleExpand(workspaceId: string, absPath: string): Promise<void>;
  loadChildren(workspaceId: string, absPath: string): Promise<void>;
  refresh(workspaceId: string, absPath?: string): Promise<void>;
  reveal(workspaceId: string, absPath: string): Promise<void>;
  setActiveAbsPath(workspaceId: string, absPath: string | null): void;
}
