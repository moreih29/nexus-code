import { create } from "zustand";
import type { DirEntry } from "../../shared/types/fs";
import { ipcCall, ipcListen } from "../ipc/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface FilesState {
  trees: Map<string, WorkspaceTree>; // key = workspaceId

  ensureRoot(workspaceId: string, rootAbsPath: string): Promise<void>;
  toggleExpand(workspaceId: string, absPath: string): Promise<void>;
  loadChildren(workspaceId: string, absPath: string): Promise<void>;
  refresh(workspaceId: string, absPath?: string): Promise<void>;
  reveal(workspaceId: string, absPath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absPathToRel(absPath: string, rootAbsPath: string): string {
  if (absPath === rootAbsPath) return "";
  const prefix = rootAbsPath.endsWith("/") ? rootAbsPath : `${rootAbsPath}/`;
  if (absPath.startsWith(prefix)) {
    return absPath.slice(prefix.length);
  }
  return absPath;
}

function joinPath(base: string, name: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${normalizedBase}/${name}`;
}

function getAncestors(rootAbsPath: string, absPath: string): string[] {
  if (absPath === rootAbsPath) return [];
  const rel = absPathToRel(absPath, rootAbsPath);
  const parts = rel.split("/");
  const ancestors: string[] = [];
  let current = rootAbsPath;
  // Include root itself and all intermediate dirs (not the target itself)
  ancestors.push(current);
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part) {
      current = joinPath(current, part);
      ancestors.push(current);
    }
  }
  return ancestors;
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    // dirs first, then by name alphabetically
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name);
  });
}

// Produce a mutable clone of a WorkspaceTree (shallow-copy mutable structures)
function cloneTree(tree: WorkspaceTree): WorkspaceTree {
  return {
    rootAbsPath: tree.rootAbsPath,
    nodes: new Map(tree.nodes),
    expanded: new Set(tree.expanded),
    loading: new Set(tree.loading),
    errors: new Map(tree.errors),
  };
}

function setTree(
  trees: Map<string, WorkspaceTree>,
  workspaceId: string,
  tree: WorkspaceTree,
): Map<string, WorkspaceTree> {
  const next = new Map(trees);
  next.set(workspaceId, tree);
  return next;
}

function parentOf(absPath: string, rootAbsPath: string): string {
  const lastSlash = absPath.lastIndexOf("/");
  if (lastSlash <= 0) return rootAbsPath;
  const parent = absPath.slice(0, lastSlash);
  // If the parent would be above root, clamp to root
  if (!parent.startsWith(rootAbsPath)) return rootAbsPath;
  return parent;
}

// ---------------------------------------------------------------------------
// Debounced persist helpers (module-level to survive re-renders)
// ---------------------------------------------------------------------------

const _saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(workspaceId: string): void {
  const existing = _saveTimers.get(workspaceId);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    _saveTimers.delete(workspaceId);
    const tree = useFilesStore.getState().trees.get(workspaceId);
    if (!tree) return;
    const relPaths: string[] = [];
    for (const absPath of tree.expanded) {
      if (absPath === tree.rootAbsPath) continue; // root is always expanded — skip
      relPaths.push(absPathToRel(absPath, tree.rootAbsPath));
    }
    ipcCall("fs", "setExpanded", { workspaceId, relPaths }).catch((err) => {
      console.error("[files] setExpanded failed", err);
    });
  }, 200);
  _saveTimers.set(workspaceId, timer);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useFilesStore = create<FilesState>((set, get) => ({
  trees: new Map(),

  async ensureRoot(workspaceId, rootAbsPath) {
    const existing = get().trees.get(workspaceId);
    if (existing) return;

    // Fetch persisted expanded relPaths before building initial tree state.
    let persistedRelPaths: string[] = [];
    try {
      const result = await ipcCall("fs", "getExpanded", { workspaceId });
      persistedRelPaths = result.relPaths;
    } catch {
      // Non-fatal — proceed with empty expanded set.
    }

    // Build initial tree with root + seeded expanded set.
    const rootNode: TreeNode = {
      absPath: rootAbsPath,
      name: rootAbsPath.split("/").filter(Boolean).pop() ?? rootAbsPath,
      type: "dir",
      childrenLoaded: false,
      children: [],
    };

    // Seed expanded set: root is always expanded, then add ancestors-first
    // for each persisted relPath so no child is expanded while its parent is not.
    const expandedSet = new Set<string>([rootAbsPath]);
    // Sort by length (ascending) = ancestors before descendants.
    const sortedRel = [...persistedRelPaths].sort((a, b) => a.length - b.length);
    for (const rel of sortedRel) {
      const abs = rel ? `${rootAbsPath}/${rel}` : rootAbsPath;
      // Also expand all intermediate ancestors.
      const parts = rel.split("/");
      let cur = rootAbsPath;
      for (const part of parts) {
        if (!part) continue;
        cur = `${cur}/${part}`;
        expandedSet.add(cur);
      }
      expandedSet.add(abs);
    }

    const tree: WorkspaceTree = {
      rootAbsPath,
      nodes: new Map([[rootAbsPath, rootNode]]),
      expanded: expandedSet,
      loading: new Set(),
      errors: new Map(),
    };

    set((state) => ({ trees: setTree(state.trees, workspaceId, tree) }));

    // Watch root.
    ipcCall("fs", "watch", { workspaceId, relPath: "" }).catch((err) => {
      console.error("[files] watch root failed", err);
    });

    // Load root children first.
    await get().loadChildren(workspaceId, rootAbsPath);

    // Then hydrate each persisted expanded dir (ancestors-first = shorter relPath first).
    // This ensures parent nodes are loaded before children are attempted.
    for (const rel of sortedRel) {
      const abs = rel ? `${rootAbsPath}/${rel}` : rootAbsPath;
      if (abs === rootAbsPath) continue; // already loaded above
      const currentTree = get().trees.get(workspaceId);
      if (!currentTree) break;
      const node = currentTree.nodes.get(abs);
      if (node && node.type === "dir" && !node.childrenLoaded) {
        await get().loadChildren(workspaceId, abs);
      }
      // Re-register watch for each hydrated expanded dir.
      ipcCall("fs", "watch", { workspaceId, relPath: rel }).catch((err) => {
        console.error("[files] watch hydrated dir failed", err);
      });
    }
  },

  async toggleExpand(workspaceId, absPath) {
    const tree = get().trees.get(workspaceId);
    if (!tree) return;

    const node = tree.nodes.get(absPath);
    if (!node || node.type !== "dir") return;

    const isExpanded = tree.expanded.has(absPath);

    const relPath = absPathToRel(absPath, tree.rootAbsPath);

    if (isExpanded) {
      // Collapse
      set((state) => {
        const t = get().trees.get(workspaceId);
        if (!t) return state;
        const next = cloneTree(t);
        next.expanded.delete(absPath);
        return { trees: setTree(state.trees, workspaceId, next) };
      });
      ipcCall("fs", "unwatch", { workspaceId, relPath }).catch((err) => {
        console.error("[files] unwatch failed", err);
      });
      scheduleSave(workspaceId);
    } else {
      // Expand
      set((state) => {
        const t = get().trees.get(workspaceId);
        if (!t) return state;
        const next = cloneTree(t);
        next.expanded.add(absPath);
        return { trees: setTree(state.trees, workspaceId, next) };
      });
      ipcCall("fs", "watch", { workspaceId, relPath }).catch((err) => {
        console.error("[files] watch failed", err);
      });
      scheduleSave(workspaceId);

      const currentNode = get().trees.get(workspaceId)?.nodes.get(absPath);
      if (currentNode && !currentNode.childrenLoaded) {
        await get().loadChildren(workspaceId, absPath);
      }
    }
  },

  async loadChildren(workspaceId, absPath) {
    const tree = get().trees.get(workspaceId);
    if (!tree) return;

    const { rootAbsPath } = tree;
    const relPath = absPathToRel(absPath, rootAbsPath);

    // Mark loading
    set((state) => {
      const t = state.trees.get(workspaceId);
      if (!t) return state;
      const next = cloneTree(t);
      next.loading.add(absPath);
      next.errors.delete(absPath);
      return { trees: setTree(state.trees, workspaceId, next) };
    });

    try {
      const entries = await ipcCall("fs", "readdir", { workspaceId, relPath });
      const sorted = sortEntries(entries);

      set((state) => {
        const t = state.trees.get(workspaceId);
        if (!t) return state;
        const next = cloneTree(t);

        const childAbsPaths: string[] = [];
        for (const entry of sorted) {
          const childAbsPath = joinPath(absPath, entry.name);
          childAbsPaths.push(childAbsPath);
          // Only insert if not already present to preserve childrenLoaded state
          if (!next.nodes.has(childAbsPath)) {
            next.nodes.set(childAbsPath, {
              absPath: childAbsPath,
              name: entry.name,
              type: entry.type,
              childrenLoaded: false,
              children: [],
            });
          }
        }

        const parentNode = next.nodes.get(absPath);
        if (parentNode) {
          next.nodes.set(absPath, {
            ...parentNode,
            children: childAbsPaths,
            childrenLoaded: true,
          });
        }

        next.loading.delete(absPath);
        return { trees: setTree(state.trees, workspaceId, next) };
      });
    } catch (err) {
      set((state) => {
        const t = state.trees.get(workspaceId);
        if (!t) return state;
        const next = cloneTree(t);
        next.loading.delete(absPath);
        next.errors.set(absPath, err instanceof Error ? err.message : String(err));
        return { trees: setTree(state.trees, workspaceId, next) };
      });
    }
  },

  async refresh(workspaceId, absPath) {
    const tree = get().trees.get(workspaceId);
    if (!tree) return;

    const targetPath = absPath ?? tree.rootAbsPath;
    const node = tree.nodes.get(targetPath);
    if (!node) return;

    // Remove all descendant nodes, reset childrenLoaded
    set((state) => {
      const t = state.trees.get(workspaceId);
      if (!t) return state;
      const next = cloneTree(t);

      // Collect all descendants to remove
      const toRemove = new Set<string>();
      const queue = [...(next.nodes.get(targetPath)?.children ?? [])];
      while (queue.length > 0) {
        const cur = queue.shift();
        if (cur === undefined) break;
        toRemove.add(cur);
        const curNode = next.nodes.get(cur);
        if (curNode) {
          for (const child of curNode.children) {
            queue.push(child);
          }
        }
      }

      for (const path of toRemove) {
        next.nodes.delete(path);
      }

      const targetNode = next.nodes.get(targetPath);
      if (targetNode) {
        next.nodes.set(targetPath, {
          ...targetNode,
          children: [],
          childrenLoaded: false,
        });
      }

      return { trees: setTree(state.trees, workspaceId, next) };
    });

    await get().loadChildren(workspaceId, targetPath);
  },

  async reveal(workspaceId, absPath) {
    const tree = get().trees.get(workspaceId);
    if (!tree) return;

    const ancestors = getAncestors(tree.rootAbsPath, absPath);

    for (const ancestor of ancestors) {
      const currentTree = get().trees.get(workspaceId);
      if (!currentTree) break;

      const node = currentTree.nodes.get(ancestor);
      if (!node || node.type !== "dir") continue;

      if (!currentTree.expanded.has(ancestor)) {
        set((state) => {
          const t = state.trees.get(workspaceId);
          if (!t) return state;
          const next = cloneTree(t);
          next.expanded.add(ancestor);
          return { trees: setTree(state.trees, workspaceId, next) };
        });
      }

      const afterExpand = get().trees.get(workspaceId);
      const afterNode = afterExpand?.nodes.get(ancestor);
      if (afterNode && !afterNode.childrenLoaded) {
        await get().loadChildren(workspaceId, ancestor);
      }
    }
  },
}));

// ---------------------------------------------------------------------------
// Pure selector — call from component with useMemo
// ---------------------------------------------------------------------------

export function selectFlat(state: FilesState, workspaceId: string): FlatItem[] {
  const tree = state.trees.get(workspaceId);
  if (!tree) return [];

  const result: FlatItem[] = [];
  const { nodes, expanded, rootAbsPath } = tree;

  function visit(absPath: string, depth: number): void {
    const node = nodes.get(absPath);
    if (!node) return;
    result.push({ absPath, node, depth });

    if (node.type === "dir" && expanded.has(absPath) && node.childrenLoaded) {
      for (const childAbsPath of node.children) {
        visit(childAbsPath, depth + 1);
      }
    }
  }

  visit(rootAbsPath, 0);
  return result;
}

// ---------------------------------------------------------------------------
// Module-level fs.changed subscription
// Registers once when this module is first imported. The unsubscribe function
// is kept internally for potential future cleanup (e.g., HMR).
// ---------------------------------------------------------------------------

export function handleFsChanged(event: { workspaceId: string; changes: { relPath: string; kind: string }[] }): void {
  const { workspaceId, changes } = event;
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const { rootAbsPath } = tree;

  // Compute the set of unique parent absPath values affected by the changes
  const parentSet = new Set<string>();
  for (const change of changes) {
    const absPath = change.relPath ? joinPath(rootAbsPath, change.relPath) : rootAbsPath;
    const parent = parentOf(absPath, rootAbsPath);
    parentSet.add(parent);
  }

  for (const parentAbsPath of parentSet) {
    const currentTree = useFilesStore.getState().trees.get(workspaceId);
    if (!currentTree) break;

    const parentNode = currentTree.nodes.get(parentAbsPath);
    if (!parentNode) continue;

    if (currentTree.expanded.has(parentAbsPath) && parentNode.childrenLoaded) {
      // Directory is currently visible — reload children immediately
      useFilesStore.getState().loadChildren(workspaceId, parentAbsPath).catch((err) => {
        console.error("[files] changed reload failed", err);
      });
    } else {
      // Directory is collapsed or not yet loaded — mark stale so next expand reloads
      useFilesStore.setState((state) => {
        const t = state.trees.get(workspaceId);
        if (!t) return state;
        const next = cloneTree(t);
        const node = next.nodes.get(parentAbsPath);
        if (node) {
          next.nodes.set(parentAbsPath, { ...node, childrenLoaded: false });
        }
        return { trees: setTree(state.trees, workspaceId, next) };
      });
    }
  }
}

const _unsubscribeFsChanged =
  typeof window !== "undefined"
    ? ipcListen("fs", "changed", handleFsChanged)
    : undefined;
