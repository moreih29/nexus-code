import type { FsChangedEvent } from "../../../../shared/types/fs";
import { ipcListen } from "../../../ipc/client";
import { loadChildren } from "../../operations/files";
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
 */
export function handleFsChanged(event: FsChangedEvent): void {
  const { workspaceId, changes } = event;
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const { rootAbsPath } = tree;

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
      loadChildren(workspaceId, parentAbsPath).catch((err) => {
        console.error("[files] changed reload failed", err);
      });
    } else {
      useFilesStore.getState().markChildrenStale(workspaceId, parentAbsPath);
    }
  }
}

const _unsubscribeFsChanged =
  typeof window !== "undefined" ? ipcListen("fs", "changed", handleFsChanged) : undefined;

void _unsubscribeFsChanged;
