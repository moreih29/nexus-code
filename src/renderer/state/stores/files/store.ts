import { create } from "zustand";
import { registerWorkspaceCleanup } from "../../workspace-cleanup";
import { cloneTree, setTree, sortEntries } from "./helpers";
import {
  emptySelection,
  extendSelection,
  selectAll,
  selectAllHierarchical,
  singleSelection,
  toggleInSelection,
} from "./selection";
import type { FileSelection, FilesState, TreeNode, WorkspaceTree } from "./types";

export const useFilesStore = create<FilesState>((set, get) => {
  // Drop all workspace-keyed state when its workspace is removed.
  registerWorkspaceCleanup((id) => {
    get().closeAllForWorkspace(id);
  });

  // requestRename용 단조 증가 카운터. 클로저에 보관하여 set/get 없이 접근.
  let renameRequestCounter = 0;

  return {
    trees: new Map(),
    selection: new Map(),
    pendingRenameRequest: null,

    requestRename(absPath) {
      renameRequestCounter += 1;
      set({ pendingRenameRequest: { absPath, requestId: renameRequestCounter } });
    },

    // -------------------------------------------------------------------------
    // Selection reducers
    // -------------------------------------------------------------------------

    setSingleSelection(workspaceId, path) {
      set((state) => {
        const cur = state.selection.get(workspaceId);
        // No-op when paths already equals exactly {path} with focus/anchor on it
        // (stable reference; matches the post-Fix shape of singleSelection).
        if (
          cur &&
          cur.focus === path &&
          cur.anchor === path &&
          cur.paths.size === 1 &&
          cur.paths.has(path)
        ) {
          return state;
        }
        const next = new Map(state.selection);
        next.set(workspaceId, singleSelection(path));
        return { selection: next };
      });
    },

    toggleSelection(workspaceId, path) {
      set((state) => {
        const cur = state.selection.get(workspaceId) ?? emptySelection();
        const next = new Map(state.selection);
        next.set(workspaceId, toggleInSelection(cur, path));
        return { selection: next };
      });
    },

    extendSelectionTo(workspaceId, target, flatPaths) {
      set((state) => {
        const cur = state.selection.get(workspaceId) ?? emptySelection();
        const next = new Map(state.selection);
        next.set(workspaceId, extendSelection(cur, cur.anchor, target, flatPaths));
        return { selection: next };
      });
    },

    selectAllVisible(workspaceId, flatPaths) {
      set((state) => {
        const next = new Map(state.selection);
        next.set(workspaceId, selectAll(flatPaths));
        return { selection: next };
      });
    },

    selectAllVisibleHierarchical(workspaceId, flatPaths, rootAbsPath) {
      set((state) => {
        const cur = state.selection.get(workspaceId) ?? emptySelection();
        const next = new Map(state.selection);
        next.set(workspaceId, selectAllHierarchical(cur, flatPaths, rootAbsPath));
        return { selection: next };
      });
    },

    clearToFocus(workspaceId) {
      set((state) => {
        const cur = state.selection.get(workspaceId);
        if (!cur) return state;
        // Already in the canonical single-selection shape — no-op.
        if (
          cur.focus !== null &&
          cur.anchor === cur.focus &&
          cur.paths.size === 1 &&
          cur.paths.has(cur.focus)
        ) {
          return state;
        }
        const next = new Map(state.selection);
        const cleared: FileSelection =
          cur.focus !== null
            ? singleSelection(cur.focus)
            : { focus: null, anchor: null, paths: new Set() };
        next.set(workspaceId, cleared);
        return { selection: next };
      });
    },

    setFocus(workspaceId, path) {
      set((state) => {
        const cur = state.selection.get(workspaceId);
        if (cur && cur.focus === path) return state;
        const next = new Map(state.selection);
        // Preserve anchor and paths — only move the focus cursor.
        const existing = cur ?? emptySelection();
        next.set(workspaceId, { ...existing, focus: path });
        return { selection: next };
      });
    },

    clearSelection(workspaceId) {
      set((state) => {
        if (!state.selection.has(workspaceId)) return state;
        const next = new Map(state.selection);
        next.set(workspaceId, emptySelection());
        return { selection: next };
      });
    },

    // -------------------------------------------------------------------------
    // Tree reducers (unchanged logic, preserved verbatim)
    // -------------------------------------------------------------------------

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

    closeAllForWorkspace(workspaceId) {
      set((state) => {
        const hasTree = state.trees.has(workspaceId);
        const hasSel = state.selection.has(workspaceId);
        if (!hasTree && !hasSel) return state;

        const patch: Partial<FilesState> = {};
        if (hasTree) {
          const nextTrees = new Map(state.trees);
          nextTrees.delete(workspaceId);
          patch.trees = nextTrees;
        }
        if (hasSel) {
          const nextSel = new Map(state.selection);
          nextSel.delete(workspaceId);
          patch.selection = nextSel;
        }
        return patch;
      });
    },
  };
});
