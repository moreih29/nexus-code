import type { FsChangedEvent } from "../../../../shared/fs/types";
import { createLogger } from "../../../../shared/log/renderer";
import { ipcListen } from "../../../ipc/client";

const log = createLogger("files");

import { loadChildren, rewatchExpandedDir } from "../../operations/files";
import { joinPath, parentOf } from "./helpers";
import { useFilesStore } from "./store";

/**
 * Reconciles the file tree store with a watcher-driven `fs.changed` event.
 *
 * For each changed path the parent directory is invalidated: if the parent is
 * currently expanded and its children have been loaded, the children are
 * re-fetched eagerly; otherwise the parent is marked stale so the next
 * expansion re-loads. The module-level subscription at the bottom of this
 * file wires it to the IPC bus on the renderer.
 *
 * A path reported as "added" that is itself a known directory was (re)created
 * — e.g. a build output or codegen folder deleted and rewritten. Its old OS
 * watch died with the old inode and its cached listing is from before, so an
 * expanded one is re-watched and re-read, a collapsed one marked stale.
 */
export function handleFsChanged(event: FsChangedEvent): void {
  const { workspaceId, changes } = event;
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const { rootAbsPath } = tree;

  const parentSet = new Set<string>();
  const addedPaths: string[] = [];
  for (const change of changes) {
    const absPath = change.relPath ? joinPath(rootAbsPath, change.relPath) : rootAbsPath;
    const parent = parentOf(absPath, rootAbsPath);
    parentSet.add(parent);
    if (change.kind === "added" && change.relPath) addedPaths.push(absPath);
  }

  const parentReloads = new Map<string, Promise<void>>();
  for (const parentAbsPath of parentSet) {
    const currentTree = useFilesStore.getState().trees.get(workspaceId);
    if (!currentTree) break;

    const parentNode = currentTree.nodes.get(parentAbsPath);
    if (!parentNode) continue;

    // A folder whose first listing is still in flight counts as loaded here:
    // marking it stale would be overwritten by that (possibly older) listing
    // landing, while loadChildren queues a follow-up read behind it.
    const listed = parentNode.childrenLoaded || currentTree.loading.has(parentAbsPath);
    if (currentTree.expanded.has(parentAbsPath) && listed) {
      parentReloads.set(
        parentAbsPath,
        loadChildren(workspaceId, parentAbsPath).catch((err) => {
          log.error(`changed reload failed: ${(err as Error).message}`);
        }),
      );
    } else {
      useFilesStore.getState().markChildrenStale(workspaceId, parentAbsPath);
    }
  }

  // After the parent's listing settles: it may replace the recreated dir's
  // node with a fresh one, which must not clobber the dir's own new listing.
  for (const absPath of addedPaths) {
    const parentReload = parentReloads.get(parentOf(absPath, rootAbsPath)) ?? Promise.resolve();
    void parentReload.then(() => {
      const currentTree = useFilesStore.getState().trees.get(workspaceId);
      if (currentTree?.nodes.get(absPath)?.type !== "dir") return;
      if (currentTree.expanded.has(absPath)) {
        rewatchExpandedDir(workspaceId, absPath);
      } else {
        useFilesStore.getState().markChildrenStale(workspaceId, absPath);
      }
    });
  }
}

/**
 * Module-lifetime subscription. The unsubscribe is intentionally not
 * tracked — `fs.changed` must flow into the file tree for the full life of
 * the renderer. The guard avoids double-binding under HMR module re-exec
 * and repeated test imports.
 */
let fsChangedSubscriptionInstalled = false;
if (typeof window !== "undefined" && !fsChangedSubscriptionInstalled) {
  fsChangedSubscriptionInstalled = true;
  ipcListen("fs", "changed", handleFsChanged);
}
