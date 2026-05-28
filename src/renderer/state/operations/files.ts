/**
 * File-tree side-effect operations.
 *
 * All IPC calls that were previously embedded in the files store live here.
 * The store itself is now a pure reducer; these functions orchestrate IPC
 * and dispatch the resulting state changes through the store's reducers.
 */

import { FS_ERROR } from "../../../shared/fs/errors";
import { createKeyedDebouncer } from "../../../shared/util/keyed-debouncer";
import { FS_EXPANDED_SAVE_DEBOUNCE_MS } from "../../../shared/util/timing-constants";
import { ipcCallResult, unwrapIpcResult } from "../../ipc/client";
import { relPath } from "../../utils/path";
import { getAncestors } from "../stores/files/helpers";
import { useFilesStore } from "../stores/files/store";

/**
 * True when an `IpcErrResult.message` string carries the NOT_FOUND fs
 * error code as its prefix. Used to single out the "stale persisted
 * path" case from genuine watch failures (permissions etc.) during
 * `ensureRoot` hydration.
 */
function isNotFoundMessage(message: string): boolean {
  return message.startsWith(`${FS_ERROR.NOT_FOUND}:`);
}

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

    // Track persisted rels whose underlying path no longer exists on disk.
    // These accumulate from `fs.watch` NOT_FOUND envelopes during hydration
    // and are pruned from both the in-memory expanded set and the persisted
    // KV at the end of `ensureRoot` — without this, the same stale rels
    // would re-fire `fs.watch` (and noise the renderer console) on every
    // subsequent app start.
    const staleRels = new Set<string>();

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
          // Awaited (was fire-and-forget) so we can observe NOT_FOUND
          // results and prune them. The tree itself still updates lazily
          // via `fs.changed` events; awaiting here only delays the
          // ensureRoot resolution by one round-trip per persisted dir.
          const result = await ipcCallResult("fs", "watch", { workspaceId, relPath: rel });
          if (!result.ok) {
            if (isNotFoundMessage(result.message)) {
              staleRels.add(rel);
            } else {
              console.error("[files] watch hydrated dir failed", result.message);
            }
          }
        }),
      );
    }

    // Prune stale rels from the in-memory expanded set and persist the
    // cleaned list synchronously (we bypass `scheduleSave`'s debounce so
    // the cleanup lands before any user-driven expand/collapse can race).
    if (staleRels.size > 0) {
      const store = useFilesStore.getState();
      for (const rel of staleRels) {
        store.collapseDir(workspaceId, `${rootAbsPath}/${rel}`);
      }
      const tree = useFilesStore.getState().trees.get(workspaceId);
      if (tree) {
        const remainingRels: string[] = [];
        for (const absPath of tree.expanded) {
          if (absPath === tree.rootAbsPath) continue;
          remainingRels.push(relPath(absPath, tree.rootAbsPath));
        }
        void ipcCallResult("fs", "setExpanded", {
          workspaceId,
          relPaths: remainingRels,
        }).then((res) => {
          if (!res.ok) console.error("[files] prune setExpanded failed", res.message);
        });
      }
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
    const entries = unwrapIpcResult(
      await ipcCallResult("fs", "readdir", { workspaceId, relPath: rel }),
    );
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

/**
 * Update the file-tree selection when an editor tab becomes active.
 *
 * Selection policy (VSCode-parity with multi-select adjustment):
 *   - If `activeFile` is already in selection.paths → move focus only
 *     (preserves the multi-selection so the user does not lose their
 *     working set when cycling through already-selected files).
 *   - Otherwise → single-select `activeFile` (replaces any prior range
 *     or single focus, matching VSCode's "selectActiveFile" behaviour).
 *
 * This is a fire-and-forget synchronous call: no IPC, no Promise.
 * Callers should only invoke it from the auto-reveal Phase-2 effect
 * (after `lastRevealedRef` guard passes).
 */
export function revealEditorActiveFile(workspaceId: string, activeFile: string): void {
  const store = useFilesStore.getState();
  const sel = store.selection.get(workspaceId);
  if (sel && sel.paths.size > 0 && sel.paths.has(activeFile)) {
    // File is already in the selection set — only move focus, preserve paths.
    store.setFocus(workspaceId, activeFile);
  } else {
    // Not selected — replace with single selection (VSCode default behaviour).
    store.setSingleSelection(workspaceId, activeFile);
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
