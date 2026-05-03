import type { FsChangedEvent } from "../../../shared/types/fs";
import { ipcListen } from "../../ipc/client";
import { cloneTree, joinPath, parentOf, setTree } from "./helpers";
import { useFilesStore } from "./store";

export function handleFsChanged(event: FsChangedEvent): void {
  const { workspaceId, changes } = event;
  const tree = useFilesStore.getState().trees.get(workspaceId);
  if (!tree) return;

  const { rootAbsPath } = tree;

  // Compute the set of unique parent absPath values affected by the changes
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
      // Directory is currently visible — reload children immediately
      useFilesStore.getState().loadChildren(workspaceId, parentAbsPath).catch((err) => {
        console.error("[files] changed reload failed", err);
      });
    } else {
      // Directory is collapsed or not yet loaded — mark stale so next expand reloads
      useFilesStore.setState((state) => {
        const t = state.trees.get(workspaceId);
        if (!t) return state;
        const next = cloneTree(t);
        const node = next.nodes.get(parentAbsPath);
        if (node) {
          next.nodes.set(parentAbsPath, { ...node, childrenLoaded: false });
        }
        return { trees: setTree(state.trees, workspaceId, next) };
      });
    }
  }
}

// Module-level fs.changed subscription. Registers once when this module is
// first imported. The unsubscribe function is kept internally for potential
// future cleanup (e.g., HMR).
const _unsubscribeFsChanged =
  typeof window !== "undefined" ? ipcListen("fs", "changed", handleFsChanged) : undefined;

void _unsubscribeFsChanged;
