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

/**
 * Store bridge for the global F2 rename keybinding.
 *
 * The global command handler cannot call `startRename` directly (it is
 * component-local state). Instead it writes here; `useFileTreePendingRename`
 * watches with a useEffect and calls `startRename` whenever `requestId`
 * changes — the indirection lets the same `absPath` be renamed again after
 * an Esc cancellation (a stable absPath would not re-fire the effect).
 */
export interface PendingRenameRequest {
  absPath: string;
  /** Monotonically increasing counter; incremented on every requestRename call. */
  requestId: number;
}

export interface FilesState {
  trees: Map<string, WorkspaceTree>; // key = workspaceId
  activeAbsPath: Map<string, string | null>;
  /** null = no pending rename request from the global keybinding. */
  pendingRenameRequest: PendingRenameRequest | null;

  setActiveAbsPath(workspaceId: string, absPath: string | null): void;

  /**
   * Publish a rename request from the global F2 keybinding. Each call
   * bumps `requestId` so the hook's useEffect re-fires even when
   * `absPath` is the same (e.g. cancel → F2 again on the same row).
   */
  requestRename(absPath: string): void;

  // Pure reducers — no side effects
  initTree(workspaceId: string, rootAbsPath: string, persistedRelPaths: string[]): void;
  markChildrenLoading(workspaceId: string, absPath: string): void;
  setChildren(workspaceId: string, absPath: string, entries: DirEntry[]): void;
  setChildrenError(workspaceId: string, absPath: string, message: string): void;
  expandDir(workspaceId: string, absPath: string): void;
  collapseDir(workspaceId: string, absPath: string): void;
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
