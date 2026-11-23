import { parseUntitledCacheUri, parseWorkspaceUri } from "../../../../shared/fs/workspace-uri";
import { listDirtyCacheUris } from "../model/dirty-tracker";

export function countUnsavedBuffers(workspaceId?: string): number {
  const dirty = listDirtyCacheUris();
  if (workspaceId === undefined) return dirty.length;
  return dirty.filter(
    (cacheUri) =>
      (parseWorkspaceUri(cacheUri) ?? parseUntitledCacheUri(cacheUri))?.workspaceId === workspaceId,
  ).length;
}

export function installUnsavedChangesUnloadGuard(): void {
  window.addEventListener("beforeunload", (event) => {
    if (countUnsavedBuffers() === 0) return;
    event.preventDefault();
    event.returnValue = "";
  });
}
