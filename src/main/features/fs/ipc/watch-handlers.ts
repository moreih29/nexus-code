import { ipcContract } from "../../../../shared/ipc/contract";
import { validateArgs } from "../../../infra/ipc-router";
import type { AgentFsWatcher } from "../bridge/agent-watch";
import { runFsCall } from "./fs-result";

const c = ipcContract.fs.call;

/** Registers a directory watch and returns any expected failure in the call envelope. */
export function watchHandler(watcher: AgentFsWatcher) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.watch.args, args);
    return runFsCall(() => watcher.watch(workspaceId, relPath));
  };
}

/** Removes a directory watch through the same call contract. */
export function unwatchHandler(watcher: AgentFsWatcher) {
  return (args: unknown) => {
    const { workspaceId, relPath } = validateArgs(c.unwatch.args, args);
    return runFsCall(() => watcher.unwatch(workspaceId, relPath));
  };
}
