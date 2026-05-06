/**
 * File-tree side-effect operations.
 *
 * All IPC calls that were previously embedded in the files store live here.
 * The store itself is now a pure reducer; these functions orchestrate IPC
 * and dispatch the resulting state changes through the store's reducers.
 */

import { FS_EXPANDED_SAVE_DEBOUNCE_MS } from "../../../shared/timing-constants";
import { ipcCall } from "../../ipc/client";
import { absPathToRel, getAncestors } from "../stores/files/helpers";
import { useFilesStore } from "../stores/files/store";

// Module-level singletons — shared across all subscribers within this module.
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
      if (absPath === tree.rootAbsPath) continue;
      relPaths.push(absPathToRel(absPath, tree.rootAbsPath));
    }
    ipcCall("fs", "setExpanded", { workspaceId, relPaths }).catch((err) => {
      console.error("[files] setExpanded failed", err);
    });
  }, FS_EXPANDED_SAVE_DEBOUNCE_MS);
  _saveTimers.set(workspaceId, timer);
}

export async function ensureRoot(workspaceId: string, rootAbsPath: string): Promise<void> {
  const inflight = _ensureRootPromises.get(workspaceId);
  if (inflight) return inflight;

  const promise = (async () => {
    const existing = useFilesStore.getState().trees.get(workspaceId);
    if (existing) return;

    let persistedRelPaths: string[] = [];
    try {
      const result = await ipcCall("fs", "getExpanded", { workspaceId });
      persistedRelPaths = result.relPaths;
    } catch {
      // Non-fatal — proceed with empty expanded set.
    }

    useFilesStore.getState().initTree(workspaceId, rootAbsPath, persistedRelPaths);

    ipcCall("fs", "watch", { workspaceId, relPath: "" }).catch((err) => {
      console.error("[files] watch root failed", err);
    });

    await loadChildren(workspaceId, rootAbsPath);

    const sortedRel = [...persistedRelPaths].sort((a, b) => a.length - b.length);
    const groupsByDepth = new Map<number, string[]>();
    for (const rel of sortedRel) {
      if (!rel) continue;
      const depth = rel.split("/").length;
      const existing = groupsByDepth.get(depth);
      if (existing) existing.push(rel);
      else groupsByDepth.set(depth, [rel]);
    }

    const sortedDepths = Array.from(groupsByDepth.keys()).sort((a, b) => a - b);
    for (const depth of sortedDepths) {
      const group = groupsByDepth.get(depth);
      if (!group) continue;
      await Promise.all(
        group.map(async (rel) => {
          const abs = `${rootAbsPath}/${rel}`;
          const node = useFilesStore.getState().trees.get(workspaceId)?.nodes.get(abs);
          if (node && node.type === "dir" && !node.childrenLoaded) {
            await loadChildren(workspaceId, abs);
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
}

export async function loadChildren(workspaceId: string, absPath: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  if (tree.loading.has(absPath)) return;

  const { rootAbsPath } = tree;
  const relPath = absPathToRel(absPath, rootAbsPath);

  useFilesStore.getState().markChildrenLoading(workspaceId, absPath);

  try {
    const entries = await ipcCall("fs", "readdir", { workspaceId, relPath });
    useFilesStore.getState().setChildren(workspaceId, absPath, entries);
  } catch (err) {
    useFilesStore
      .getState()
      .setChildrenError(workspaceId, absPath, err instanceof Error ? err.message : String(err));
  }
}

export async function toggleExpand(workspaceId: string, absPath: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const node = tree.nodes.get(absPath);
  if (!node || node.type !== "dir") return;

  const isExpanded = tree.expanded.has(absPath);
  const relPath = absPathToRel(absPath, tree.rootAbsPath);

  if (isExpanded) {
    useFilesStore.getState().collapseDir(workspaceId, absPath);
    ipcCall("fs", "unwatch", { workspaceId, relPath }).catch((err) => {
      console.error("[files] unwatch failed", err);
    });
    scheduleSave(workspaceId);
  } else {
    useFilesStore.getState().expandDir(workspaceId, absPath);
    ipcCall("fs", "watch", { workspaceId, relPath }).catch((err) => {
      console.error("[files] watch failed", err);
    });
    scheduleSave(workspaceId);

    const currentNode = useFilesStore.getState().trees.get(workspaceId)?.nodes.get(absPath);
    if (currentNode && !currentNode.childrenLoaded) {
      await loadChildren(workspaceId, absPath);
    }
  }
}

export async function refresh(workspaceId: string, absPath?: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const targetPath = absPath ?? tree.rootAbsPath;
  const node = tree.nodes.get(targetPath);
  if (!node) return;

  const expandedSnapshot = new Set(tree.expanded);

  useFilesStore.getState().wipeSubtree(workspaceId, targetPath);

  let frontier = [targetPath];
  while (frontier.length > 0) {
    await Promise.all(frontier.map((p) => loadChildren(workspaceId, p)));

    const t = useFilesStore.getState().trees.get(workspaceId);
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
}

export async function reveal(workspaceId: string, absPath: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const ancestors = getAncestors(tree.rootAbsPath, absPath);

  for (const ancestor of ancestors) {
    const currentTree = useFilesStore.getState().trees.get(workspaceId);
    if (!currentTree) break;

    const node = currentTree.nodes.get(ancestor);
    if (!node || node.type !== "dir") continue;

    if (!currentTree.expanded.has(ancestor)) {
      useFilesStore.getState().expandDir(workspaceId, ancestor);
    }

    const afterExpand = useFilesStore.getState().trees.get(workspaceId);
    const afterNode = afterExpand?.nodes.get(ancestor);
    if (afterNode && !afterNode.childrenLoaded) {
      await loadChildren(workspaceId, ancestor);
    }
  }
}
