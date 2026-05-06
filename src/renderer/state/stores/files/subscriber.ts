import type { FsChangedEvent } from "../../../../shared/types/fs";
import { ipcListen } from "../../../ipc/client";
import { loadChildren } from "../../operations/files";
import { joinPath, parentOf } from "./helpers";
import { useFilesStore } from "./store";

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
