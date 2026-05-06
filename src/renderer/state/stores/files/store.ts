import { create } from "zustand";
import { cloneTree, setTree, sortEntries } from "./helpers";
import type { FilesState, TreeNode, WorkspaceTree } from "./types";

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

  initTree(workspaceId, rootAbsPath, persistedRelPaths) {
    const existing = get().trees.get(workspaceId);
    if (existing) return;

    const rootNode: TreeNode = {
      absPath: rootAbsPath,
      name: rootAbsPath.split("/").filter(Boolean).pop() ?? rootAbsPath,
      type: "dir",
      childrenLoaded: false,
      children: [],
    };

    const expandedSet = new Set<string>([rootAbsPath]);
    const sortedRel = [...persistedRelPaths].sort((a, b) => a.length - b.length);
    for (const rel of sortedRel) {
      const abs = rel ? `${rootAbsPath}/${rel}` : rootAbsPath;
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
  },

  markChildrenLoading(workspaceId, absPath) {
    set((state) => {
      const t = state.trees.get(workspaceId);
      if (!t) return state;
      const next = cloneTree(t);
      next.loading.add(absPath);
      next.errors.delete(absPath);
      return { trees: setTree(state.trees, workspaceId, next) };
    });
  },

  setChildren(workspaceId, absPath, entries) {
    const sorted = sortEntries(entries);
    set((state) => {
      const t = state.trees.get(workspaceId);
      if (!t) return state;
      const next = cloneTree(t);

      const childAbsPaths: string[] = [];
      for (const entry of sorted) {
        const childAbsPath = `${absPath}/${entry.name}`;
        childAbsPaths.push(childAbsPath);
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
  },

  setChildrenError(workspaceId, absPath, message) {
    set((state) => {
      const t = state.trees.get(workspaceId);
      if (!t) return state;
      const next = cloneTree(t);
      next.loading.delete(absPath);
      next.errors.set(absPath, message);
      return { trees: setTree(state.trees, workspaceId, next) };
    });
  },

  expandDir(workspaceId, absPath) {
    set((state) => {
      const t = get().trees.get(workspaceId);
      if (!t) return state;
      const next = cloneTree(t);
      next.expanded.add(absPath);
      return { trees: setTree(state.trees, workspaceId, next) };
    });
  },

  collapseDir(workspaceId, absPath) {
    set((state) => {
      const t = get().trees.get(workspaceId);
      if (!t) return state;
      const next = cloneTree(t);
      next.expanded.delete(absPath);
      return { trees: setTree(state.trees, workspaceId, next) };
    });
  },

  markChildrenStale(workspaceId, absPath) {
    set((state) => {
      const t = state.trees.get(workspaceId);
      if (!t) return state;
      const next = cloneTree(t);
      const node = next.nodes.get(absPath);
      if (node) {
        next.nodes.set(absPath, { ...node, childrenLoaded: false });
      }
      return { trees: setTree(state.trees, workspaceId, next) };
    });
  },

  wipeSubtree(workspaceId, targetPath) {
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
  },
}));
