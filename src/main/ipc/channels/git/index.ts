/**
 * git channel — registers Source Control panel call and stream handlers.
 */
import type { GitRegistry } from "../../../git/git-registry";
import type { WorkspaceStorage } from "../../../storage/workspace-storage";
import { register } from "../../router";
import { checkoutHandler, createBranchHandler, listBranchesHandler } from "./branch-handlers";
import { commitHandler } from "./commit-handlers";
import { getFileContentHandler } from "./content-handlers";
import { diffStream } from "./diff-stream";
import { logStream } from "./log-stream";
import { getRepoInfoHandler, initHandler, refreshDetectionHandler } from "./repo-handlers";
import { discardChangesHandler, stageHandler, unstageHandler } from "./stage-handlers";
import { stashHandler, stashPopHandler } from "./stash-handlers";
import { getPanelStateHandler, setPanelStateHandler } from "./state-handlers";
import { getStatusHandler } from "./status-handlers";
import { fetchHandler, pullHandler, pushHandler } from "./sync-handlers";

/**
 * Register the Git IPC channel's call handlers, broadcast event placeholders,
 * and cancellable stream handlers.
 */
export function registerGitChannel(registry: GitRegistry, storage: WorkspaceStorage): void {
  register("git", {
    call: {
      getRepoInfo: getRepoInfoHandler(registry),
      refreshDetection: refreshDetectionHandler(registry),
      init: initHandler(registry),
      getStatus: getStatusHandler(registry),
      stage: stageHandler(registry),
      unstage: unstageHandler(registry),
      discardChanges: discardChangesHandler(registry),
      commit: commitHandler(registry),
      checkout: checkoutHandler(registry),
      createBranch: createBranchHandler(registry),
      getFileContent: getFileContentHandler(registry),
      listBranches: listBranchesHandler(registry),
      fetch: fetchHandler(registry),
      pull: pullHandler(registry),
      push: pushHandler(registry),
      stash: stashHandler(registry),
      stashPop: stashPopHandler(registry),
      getPanelState: getPanelStateHandler(storage),
      setPanelState: setPanelStateHandler(storage),
    },
    listen: {
      repoInfoChanged: {},
      statusChanged: {},
    },
    stream: {
      log: logStream(registry),
      diff: diffStream(registry),
    },
  });
}
