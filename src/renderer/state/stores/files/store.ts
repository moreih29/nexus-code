import { create } from "zustand";
import { ipcCall } from "../../../ipc/client";
import { absPathToRel, cloneTree, getAncestors, joinPath, setTree, sortEntries } from "./helpers";
import type { FilesState, TreeNode, WorkspaceTree } from "./types";

// Module-level singletons — shared across all subscribers within this module
// instance. Keep them here (not exported) to avoid duplication on HMR or
// accidental re-import.
const _saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _ensureRootPromises = new Map<string, Promise<void>>();

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

export const useFilesStore = create<FilesState>((set, get) => ({
  trees: new Map(),
  activeAbsPath: new Map(),

  setActiveAbsPath(workspaceId, absPath) {
    set((state) => {
      const cur = state.activeAbsPath.get(workspaceId) ?? null;
      if (cur === absPath) return state;
      const next = new Map(state.activeAbsPath);
      next.set(workspaceId, absPath);
      return { activeAbsPath: next };
    });
  },

  async ensureRoot(workspaceId, rootAbsPath) {
    const inflight = _ensureRootPromises.get(workspaceId);
    if (inflight) return inflight;

    const promise = (async () => {
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

      // Hydrate persisted expanded dirs in parallel within each depth level.
      // Depth-grouped Promise.all preserves ancestors-first ordering:
      // depth 1 group fully completes before depth 2 starts, ensuring parent
      // nodes are loaded before their children are attempted.
      const groupsByDepth = new Map<number, string[]>();
      for (const rel of sortedRel) {
        if (!rel) continue; // root already loaded above
        const depth = rel.split("/").length;
        if (!groupsByDepth.has(depth)) groupsByDepth.set(depth, []);
        groupsByDepth.get(depth)!.push(rel);
      }
      const sortedDepths = Array.from(groupsByDepth.keys()).sort((a, b) => a - b);
      for (const depth of sortedDepths) {
        const group = groupsByDepth.get(depth)!;
        await Promise.all(
          group.map(async (rel) => {
            const abs = `${rootAbsPath}/${rel}`;
            const node = get().trees.get(workspaceId)?.nodes.get(abs);
            if (node && node.type === "dir" && !node.childrenLoaded) {
              await get().loadChildren(workspaceId, abs);
            }
            ipcCall("fs", "watch", { workspaceId, relPath: rel }).catch((err) => {
              console.error("[files] watch hydrated dir failed", err);
            });
          }),
        );
      }
    })();

    _ensureRootPromises.set(workspaceId, promise);
    promise.finally(() => _ensureRootPromises.delete(workspaceId));
    return promise;
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

    if (tree.loading.has(absPath)) return;

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

    // Snapshot the expanded set BEFORE wiping. The wipe deletes nodes
    // but intentionally keeps `expanded` intact so the user's open
    // chevrons aren't all lost on every refresh — but that means we
    // must re-issue readdir for those expanded paths, otherwise the
    // tree shows expanded chevrons over empty subtrees until the user
    // collapses + reopens each one. (See issue: ⌘R left a UI in the
    // "expanded but no children loaded" state.)
    const expandedSnapshot = new Set(tree.expanded);

    // Remove all descendant nodes, reset childrenLoaded on the target.
    set((state) => {
      const t = state.trees.get(workspaceId);
      if (!t) return state;
      const next = cloneTree(t);

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

    // BFS-reload along the previously-expanded subtree. Siblings load
    // in parallel; each depth waits for the previous so deeper paths
    // (which only exist as nodes once their parent's readdir lands)
    // are visible before we try to recurse into them.
    let frontier = [targetPath];
    while (frontier.length > 0) {
      await Promise.all(frontier.map((p) => get().loadChildren(workspaceId, p)));

      const t = get().trees.get(workspaceId);
      if (!t) break;
      const nextFrontier: string[] = [];
      for (const p of frontier) {
        const n = t.nodes.get(p);
        if (!n) continue;
        for (const child of n.children) {
          if (!expandedSnapshot.has(child)) continue;
          const childNode = t.nodes.get(child);
          if (childNode?.type === "dir") nextFrontier.push(child);
        }
      }
      frontier = nextFrontier;
    }
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
