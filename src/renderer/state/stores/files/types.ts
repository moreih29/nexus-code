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

/**
 * VSCode-parity selection model (mirrors listWidget.ts Trait triad):
 *
 *   focus  — the keyboard-navigated row (single, always present when tree non-empty).
 *   anchor — the Shift-click / Shift-Arrow range start; null until a range gesture starts.
 *   paths  — the full selected set (Set<string>).
 *
 * When `paths` is empty the effective "operable" target is `focus` alone;
 * when `paths` is non-empty the selected rows are the explicit working set.
 * Selection is never persisted (expanded only).
 */
export interface FileSelection {
  focus: string | null;
  anchor: string | null;
  paths: Set<string>;
}

export interface FilesState {
  trees: Map<string, WorkspaceTree>; // key = workspaceId
  /** Per-workspace selection state — replaces the old `activeAbsPath` Map. */
  selection: Map<string, FileSelection>;
  /** null = no pending rename request from the global keybinding. */
  pendingRenameRequest: PendingRenameRequest | null;

  /**
   * Publish a rename request from the global F2 keybinding. Each call
   * bumps `requestId` so the hook's useEffect re-fires even when
   * `absPath` is the same (e.g. cancel → F2 again on the same row).
   */
  requestRename(absPath: string): void;

  // Selection reducers
  /** Plain click / keyboard navigation: focus=path, anchor=path, paths={}. */
  setSingleSelection(workspaceId: string, path: string): void;
  /** Ctrl/Cmd+click: toggle one path in/out of paths, update focus. */
  toggleSelection(workspaceId: string, path: string): void;
  /** Shift+click / Shift+Arrow: extend range from anchor to target. */
  extendSelectionTo(workspaceId: string, target: string, flatPaths: readonly string[]): void;
  /** Cmd+A: select all visible rows. */
  selectAllVisible(workspaceId: string, flatPaths: readonly string[]): void;
  /** Escape: keep focus, wipe paths/anchor. */
  clearToFocus(workspaceId: string): void;
  /** Move focus without changing the selected set (modifier-free arrow). */
  setFocus(workspaceId: string, path: string): void;
  /** Wipe the entire selection for a workspace (paths={}, focus=null, anchor=null). */
  clearSelection(workspaceId: string): void;

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
