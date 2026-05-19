/**
 * File-tree side-effect operations.
 *
 * All IPC calls that were previously embedded in the files store live here.
 * The store itself is now a pure reducer; these functions orchestrate IPC
 * and dispatch the resulting state changes through the store's reducers.
 */

import { createKeyedDebouncer } from "../../../shared/util/keyed-debouncer";
import { FS_EXPANDED_SAVE_DEBOUNCE_MS } from "../../../shared/util/timing-constants";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { relPath } from "../../utils/path";
import { getAncestors } from "../stores/files/helpers";
import { useFilesStore } from "../stores/files/store";

// Module-level singletons — shared across all subscribers within this module.
const _saveDebouncer = createKeyedDebouncer<string>({ delayMs: FS_EXPANDED_SAVE_DEBOUNCE_MS });
const _ensureRootPromises = new Map<string, Promise<void>>();

function scheduleSave(workspaceId: string): void {
  _saveDebouncer.schedule(workspaceId, () => {
    const tree = useFilesStore.getState().trees.get(workspaceId);
    if (!tree) return;
    const relPaths: string[] = [];
    for (const absPath of tree.expanded) {
      if (absPath === tree.rootAbsPath) continue;
      relPaths.push(relPath(absPath, tree.rootAbsPath));
    }
    // Fire-and-forget: setExpanded persists the expanded-dirs list; local state is source of truth.
    void ipcCallResult("fs", "setExpanded", { workspaceId, relPaths }).then((result) => {
      if (!result.ok) console.error("[files] setExpanded failed", result.message);
    });
  });
}

export async function ensureRoot(workspaceId: string, rootAbsPath: string): Promise<void> {
  const inflight = _ensureRootPromises.get(workspaceId);
  if (inflight) return inflight;

  const promise = (async () => {
    const existing = useFilesStore.getState().trees.get(workspaceId);
    if (existing) return;

    let persistedRelPaths: string[] = [];
    try {
      const result = unwrapIpcResult(await ipcCallResult("fs", "getExpanded", { workspaceId }));
      persistedRelPaths = result.relPaths;
    } catch {
      // Non-fatal — proceed with empty expanded set.
    }

    useFilesStore.getState().initTree(workspaceId, rootAbsPath, persistedRelPaths);

    // Fire-and-forget: watch registration; tree updates arrive via fs.changed events.
    void ipcCallResult("fs", "watch", { workspaceId, relPath: "" }).then((result) => {
      if (!result.ok) console.error("[files] watch root failed", result.message);
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
          // Fire-and-forget: watch registration; tree updates arrive via fs.changed events.
          void ipcCallResult("fs", "watch", { workspaceId, relPath: rel }).then((result) => {
            if (!result.ok)
              console.error("[files] watch hydrated dir failed", result.message);
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
  const rel = relPath(absPath, rootAbsPath);

  useFilesStore.getState().markChildrenLoading(workspaceId, absPath);

  try {
    const entries = unwrapIpcResult(await ipcCallResult("fs", "readdir", { workspaceId, relPath: rel }));
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
  const rel = relPath(absPath, tree.rootAbsPath);

  if (isExpanded) {
    useFilesStore.getState().collapseDir(workspaceId, absPath);
    // Fire-and-forget: unwatch is best-effort cleanup.
    void ipcCallResult("fs", "unwatch", { workspaceId, relPath: rel }).then((result) => {
      if (!result.ok) console.error("[files] unwatch failed", result.message);
    });
    scheduleSave(workspaceId);
  } else {
    useFilesStore.getState().expandDir(workspaceId, absPath);
    // Fire-and-forget: watch registration; tree updates arrive via fs.changed events.
    void ipcCallResult("fs", "watch", { workspaceId, relPath: rel }).then((result) => {
      if (!result.ok) console.error("[files] watch failed", result.message);
    });
    scheduleSave(workspaceId);

    const currentNode = useFilesStore.getState().trees.get(workspaceId)?.nodes.get(absPath);
    if (currentNode && !currentNode.childrenLoaded) {
      await loadChildren(workspaceId, absPath);
    }
  }
}

/**
 * Bulk-expand every directory whose children are already cached.
 *
 * Skips dirs whose children have never been loaded (`childrenLoaded === false`)
 * so the operation is free of IPC and instant — no `fs.readdir` storms even on
 * a 10k-folder workspace. For each newly-expanded dir, registers an `fs.watch`
 * so subsequent filesystem changes propagate as if the user had clicked each
 * row by hand. Persistence is debounced through the same `scheduleSave` path
 * used by toggleExpand.
 */
export async function expandAllLoaded(workspaceId: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const toExpand: string[] = [];
  for (const [absPath, node] of tree.nodes) {
    if (node.type !== "dir") continue;
    if (!node.childrenLoaded) continue;
    if (tree.expanded.has(absPath)) continue;
    toExpand.push(absPath);
  }
  if (toExpand.length === 0) return;

  useFilesStore.getState().expandMany(workspaceId, toExpand);

  // Re-register watches for the newly-expanded dirs. Watches were dropped
  // when the user originally collapsed each one, so the cached children
  // stop receiving change events otherwise.
  for (const absPath of toExpand) {
    const rel = relPath(absPath, tree.rootAbsPath);
    void ipcCallResult("fs", "watch", { workspaceId, relPath: rel }).then((result) => {
      if (!result.ok) console.error("[files] watch (expand-all) failed", result.message);
    });
  }

  scheduleSave(workspaceId);
}

/**
 * Collapse every directory in the workspace tree, leaving only the workspace
 * root expanded. Cached children stay in memory so re-expanding any directory
 * is instant. Each previously-watched dir gets an `fs.unwatch` to release
 * resources symmetrically with the per-row collapse path.
 */
export async function collapseAll(workspaceId: string): Promise<void> {
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const toUnwatch: string[] = [];
  for (const absPath of tree.expanded) {
    if (absPath === tree.rootAbsPath) continue;
    toUnwatch.push(absPath);
  }
  if (toUnwatch.length === 0) return;

  useFilesStore.getState().collapseAll(workspaceId);

  for (const absPath of toUnwatch) {
    const rel = relPath(absPath, tree.rootAbsPath);
    void ipcCallResult("fs", "unwatch", { workspaceId, relPath: rel }).then((result) => {
      if (!result.ok) console.error("[files] unwatch (collapse-all) failed", result.message);
    });
  }

  scheduleSave(workspaceId);
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
