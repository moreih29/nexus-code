// Guards against losing unsaved buffers to paths that bypass the per-tab
// close prompt: quitting, closing or reloading the window, and removing a
// workspace.

import { parseUntitledCacheUri, parseWorkspaceUri } from "../../../../shared/fs/workspace-uri";
import { listDirtyCacheUris } from "../model/dirty-tracker";

/** Number of buffers with unsaved edits, optionally within one workspace. */
export function countUnsavedBuffers(workspaceId?: string): number {
  const dirty = listDirtyCacheUris();
  if (workspaceId === undefined) return dirty.length;
  return dirty.filter(
    (cacheUri) =>
      (parseWorkspaceUri(cacheUri) ?? parseUntitledCacheUri(cacheUri))?.workspaceId === workspaceId,
  ).length;
}

/**
 * Cancels window unload (quit, window close, reload) while any buffer is
 * unsaved. Electron cancels silently; main asks the user on
 * `will-prevent-unload` and lets the unload proceed if they discard.
 */
export function installUnsavedChangesUnloadGuard(): void {
  window.addEventListener("beforeunload", (event) => {
    if (countUnsavedBuffers() === 0) return;
    event.preventDefault();
    // Legacy signal Chromium still requires to treat the unload as cancelled.
    event.returnValue = "";
  });
}
