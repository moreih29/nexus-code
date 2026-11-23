import type { FsChangedEvent } from "../../../../shared/fs/types";
import { createLogger } from "../../../../shared/log/renderer";
import { canUseIpcBridge, ipcListen } from "../../../ipc/client";

const log = createLogger("files");

import { loadChildren, rewatchExpandedDir } from "../../operations/files";
import { joinPath, parentOf } from "./helpers";
import { useFilesStore } from "./store";

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

let fsChangedSubscriptionInstalled = false;
if (canUseIpcBridge() && !fsChangedSubscriptionInstalled) {
  fsChangedSubscriptionInstalled = true;
  ipcListen("fs", "changed", handleFsChanged);
}
