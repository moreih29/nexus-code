/**
 * git channel — registers Source Control panel call and stream handlers.
 */

import type { GitAutofetchScheduler } from "../../../git/git-autofetch";
import type { GitRegistry } from "../../../git/git-registry";
import type { WorkspaceStorage } from "../../../storage/workspace-storage";
import { register } from "../../router";
import { checkoutHandler, checkoutTrackingHandler, listBranchesHandler } from "./branch-handlers";
import {
  createBranchHandler,
  deleteBranchHandler,
  deleteRemoteBranchHandler,
  fastForwardBranchHandler,
  renameBranchHandler,
  setUpstreamHandler,
} from "./branch-ops-handlers";
import { cloneStream } from "./clone-handlers";
import {
  commitAmendHandler,
  commitEmptyHandler,
  commitHandler,
  undoLastCommitHandler,
} from "./commit-handlers";
import { getFileContentHandler } from "./content-handlers";
import { diffStream } from "./diff-stream";
import { getFileBlobStream, openFileAtHeadHandler } from "./file-handlers";
import {
  checkoutDetachedHandler,
  commitDetailHandler,
  resetSoftHandler,
  searchCommitsHandler,
} from "./history-handlers";
import { addToGitignoreHandler } from "./ignore-handlers";
import { logStream } from "./log-stream";
import { addRemoteHandler, removeRemoteHandler } from "./remote-handlers";
import { getRepoInfoHandler, initHandler, refreshDetectionHandler } from "./repo-handlers";
import { discardChangesHandler, stageHandler, unstageHandler } from "./stage-handlers";
import {
  stashApplyHandler,
  stashDropHandler,
  stashGroupHandler,
  stashHandler,
  stashListHandler,
  stashPopHandler,
  stashShowStream,
} from "./stash-handlers";
import { getPanelStateHandler, setPanelStateHandler } from "./state-handlers";
import { getStatusHandler } from "./status-handlers";
import {
  fetchAllHandler,
  fetchHandler,
  pullHandler,
  pushHandler,
  syncHandler,
} from "./sync-handlers";
import {
  createTagHandler,
  deleteRemoteTagHandler,
  deleteTagHandler,
  listTagsHandler,
} from "./tag-handlers";
import {
  abortOpHandler,
  cherryPickHandler,
  continueOpHandler,
  markResolvedHandler,
  mergeHandler,
  rebaseHandler,
} from "./workflow-handlers";

/**
 * Register the Git IPC channel's call handlers, broadcast event placeholders,
 * and cancellable stream handlers.
 */
export function registerGitChannel(
  registry: GitRegistry,
  storage: WorkspaceStorage,
  autofetch?: GitAutofetchScheduler,
): void {
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
      commitAmend: commitAmendHandler(registry),
      undoLastCommit: undoLastCommitHandler(registry),
      commitEmpty: commitEmptyHandler(registry),
      checkout: checkoutHandler(registry),
      checkoutTracking: checkoutTrackingHandler(registry),
      createBranch: createBranchHandler(registry),
      deleteBranch: deleteBranchHandler(registry),
      deleteRemoteBranch: deleteRemoteBranchHandler(registry),
      renameBranch: renameBranchHandler(registry),
      setUpstream: setUpstreamHandler(registry),
      fastForwardBranch: fastForwardBranchHandler(registry),
      merge: mergeHandler(registry),
      rebase: rebaseHandler(registry),
      cherryPick: cherryPickHandler(registry),
      commitDetail: commitDetailHandler(registry),
      searchCommits: searchCommitsHandler(registry),
      checkoutDetached: checkoutDetachedHandler(registry),
      resetSoft: resetSoftHandler(registry),
      abortOp: abortOpHandler(registry),
      continueOp: continueOpHandler(registry),
      markResolved: markResolvedHandler(registry),
      addRemote: addRemoteHandler(registry),
      removeRemote: removeRemoteHandler(registry),
      getFileContent: getFileContentHandler(registry),
      openFileAtHead: openFileAtHeadHandler(registry),
      addToGitignore: addToGitignoreHandler(registry),
      listBranches: listBranchesHandler(registry),
      listTags: listTagsHandler(registry),
      createTag: createTagHandler(registry),
      deleteTag: deleteTagHandler(registry),
      deleteRemoteTag: deleteRemoteTagHandler(registry),
      fetch: fetchHandler(registry),
      fetchAll: fetchAllHandler(registry, autofetch),
      pull: pullHandler(registry),
      push: pushHandler(registry),
      sync: syncHandler(registry),
      stash: stashHandler(registry),
      stashPop: stashPopHandler(registry),
      stashList: stashListHandler(registry),
      stashApply: stashApplyHandler(registry),
      stashDrop: stashDropHandler(registry),
      stashGroup: stashGroupHandler(registry),
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
      getFileBlob: getFileBlobStream(registry),
      stashShow: stashShowStream(registry),
      clone: cloneStream(registry),
    },
  });
}
