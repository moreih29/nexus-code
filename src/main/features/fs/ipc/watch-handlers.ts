/**
 * fs watch handlers — watch / unwatch lifecycle.
 */
import { ipcContract } from "../../../../shared/ipc/ipc-contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { AgentFsWatcher } from "../bridge/agent-watch";

const c = ipcContract.fs.call;

export function watchHandler(
  watcher: AgentFsWatcher,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.watch.args, args);
    await watcher.watch(workspaceId, relPath);
  };
}

export function unwatchHandler(
  watcher: AgentFsWatcher,
): (args: unknown) => Promise<void> {
  return async (args: unknown): Promise<void> => {
    const { workspaceId, relPath } = validateArgs(c.unwatch.args, args);
    await watcher.unwatch(workspaceId, relPath);
  };
}
