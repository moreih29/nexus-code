import type { DirEntry } from "../../../../shared/types/fs";
import { relPath } from "../../../utils/path";
import type { FilesState, FlatItem, WorkspaceTree } from "./types";

export function joinPath(base: string, name: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${normalizedBase}/${name}`;
}

export function getAncestors(rootAbsPath: string, absPath: string): string[] {
  if (absPath === rootAbsPath) return [];
  const rel = relPath(absPath, rootAbsPath);
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

export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    // dirs first, then by name alphabetically
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name);
  });
}

// Produce a mutable clone of a WorkspaceTree (shallow-copy mutable structures)
export function cloneTree(tree: WorkspaceTree): WorkspaceTree {
  return {
    rootAbsPath: tree.rootAbsPath,
    nodes: new Map(tree.nodes),
    expanded: new Set(tree.expanded),
    loading: new Set(tree.loading),
    errors: new Map(tree.errors),
  };
}

export function setTree(
  trees: Map<string, WorkspaceTree>,
  workspaceId: string,
  tree: WorkspaceTree,
): Map<string, WorkspaceTree> {
  const next = new Map(trees);
  next.set(workspaceId, tree);
  return next;
}

export function parentOf(absPath: string, rootAbsPath: string): string {
  const lastSlash = absPath.lastIndexOf("/");
  if (lastSlash <= 0) return rootAbsPath;
  const parent = absPath.slice(0, lastSlash);
  // If the parent would be above root, clamp to root
  if (!parent.startsWith(rootAbsPath)) return rootAbsPath;
  return parent;
}

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
