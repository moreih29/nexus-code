/**
 * fs watch handlers — watch / unwatch lifecycle.
 *
 * Both handlers catch agent-thrown fs errors and return them as a typed
 * `ipcErr` envelope (matches the read-handlers pattern). The motivating
 * case is `ensureRoot`'s hydration loop: every persisted expanded path
 * triggers a `fs.watch` call, and if the user has deleted the folder on
 * disk between sessions the agent throws NOT_FOUND. Without this
 * envelope the rejection reaches Electron's `ipcMain.handle` invocation
 * logger, which prints
 *   "Error occurred in handler for 'ipc:call': Error: NOT_FOUND: …"
 * on every stale row. The renderer side is unchanged — `unwrapIpcResult`
 * still throws the same `"CODE: …"` message that `hasFsErrorCode` can
 * classify — so call sites that previously surfaced toasts keep working.
 */
import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { AgentFsWatcher } from "../bridge/agent-watch";
import { type FsIpcErrorResult, fsErrorToIpcResult, isFsError } from "./fs-result";

const c = ipcContract.fs.call;

export function watchHandler(
  watcher: AgentFsWatcher,
): (args: unknown) => Promise<void | FsIpcErrorResult> {
  return async (args: unknown): Promise<void | FsIpcErrorResult> => {
    const { workspaceId, relPath } = validateArgs(c.watch.args, args);
    try {
      await watcher.watch(workspaceId, relPath);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}

export function unwatchHandler(
  watcher: AgentFsWatcher,
): (args: unknown) => Promise<void | FsIpcErrorResult> {
  return async (args: unknown): Promise<void | FsIpcErrorResult> => {
    const { workspaceId, relPath } = validateArgs(c.unwatch.args, args);
    try {
      await watcher.unwatch(workspaceId, relPath);
    } catch (error) {
      if (isFsError(error)) return fsErrorToIpcResult(error);
      throw error;
    }
  };
}
