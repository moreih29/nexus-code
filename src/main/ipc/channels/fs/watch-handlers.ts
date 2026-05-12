/**
 * fs watch handlers — watch / unwatch lifecycle.
 */
import { ipcContract } from "../../../../shared/ipc-contract";
import type { FileWatcher } from "../../../filesystem/file-watcher";
import { isLocalWorkspace, requireWorkspace } from "../../../workspace/workspace-guards";
import type { WorkspaceManager } from "../../../workspace/workspace-manager";
import { validateArgs } from "../../router";
import { resolveSafe } from "./path-safety";

const c = ipcContract.fs.call;

export function watchHandler(
  manager: WorkspaceManager,
  watcher: FileWatcher,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.watch.args, args);
    const workspace = requireWorkspace(manager, workspaceId);
    if (!isLocalWorkspace(workspace)) {
      return;
    }
    const absDir = resolveSafe(manager, workspaceId, relPath, "watch workspace files");
    watcher.watch(workspaceId, workspace.location.rootPath, absDir);
  };
}

export function unwatchHandler(
  manager: WorkspaceManager,
  watcher: FileWatcher,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.unwatch.args, args);
    const workspace = requireWorkspace(manager, workspaceId);
    if (!isLocalWorkspace(workspace)) {
      return;
    }
    const absDir = resolveSafe(manager, workspaceId, relPath, "watch workspace files");
    watcher.unwatch(workspaceId, absDir);
  };
}
