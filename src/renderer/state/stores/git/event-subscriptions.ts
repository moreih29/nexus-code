/**
 * Wires main → renderer git broadcasts into the git store. Each handler
 * applies its event onto an existing session — events for workspaces the
 * renderer hasn't loaded yet are dropped silently so an early broadcast
 * never instantiates a half-filled session.
 *
 * `fs.changed` is forwarded as a passive status hint (debounced refresh)
 * rather than a status mutation, so working-tree edits never claim the
 * operation spinner away from a user-initiated git command.
 */

import type { GitAutofetchStateChanged, RepoInfo } from "../../../../shared/git/types";
import { canUseIpcBridge, ipcListen } from "../../../ipc/client";
import { scheduleStatusHintRefresh } from "./draft-persistence";
import { shouldInvalidateIgnoredCache, useIgnoredStore } from "./ignored";
import { useGitStore } from "./index";
import { sanitizeExpandedTreeNodes } from "./panel-ui";
import { withSlashTopLevel } from "./store-helpers";

/**
 * Applies background autofetch state from main without overwriting unrelated
 * Git operation errors. The paused banner is edge-triggered by main so it
 * appears once per three-strikes pause.
 */
function applyAutofetchEvent(event: GitAutofetchStateChanged): void {
  useGitStore.setState((state) => {
    const session = state.sessions.get(event.workspaceId);
    if (!session) return state;

    const next = new Map(state.sessions);
    next.set(event.workspaceId, {
      ...session,
      autofetchFetching: event.fetching,
      autofetchManualPaused: event.paused,
      autofetchConsecutiveFailures: event.consecutiveFailures,
      autofetchLastError: event.lastError,
      autofetchPausedBannerVisible:
        event.showPausedBanner || (event.paused ? session.autofetchPausedBannerVisible : false),
    });
    return { sessions: next };
  });
}

/**
 * Applies a repository detection result from main. Leaving the repo state
 * drops its status; reaching it without one reads the status again.
 *
 * The renderer can handle a broadcast after the reply to a call that main
 * sent later: the detecting → repo pair of the detection `getRepoInfo` waited
 * on can arrive once `loadInitial` has stored the status it fetched, and
 * clear it. A repository whose status did not change gets no statusChanged
 * to fill it back in.
 */
export function applyRepoInfoEvent(workspaceId: string, incoming: RepoInfo): void {
  const info = withSlashTopLevel(incoming);
  useGitStore.setState((state) => {
    const session = state.sessions.get(workspaceId);
    if (!session) return state;

    const next = new Map(state.sessions);
    next.set(workspaceId, {
      ...session,
      repoInfo: info,
      status: info.kind === "repo" ? session.status : null,
      branchInfo: info.kind === "repo" ? session.branchInfo : null,
    });
    return { sessions: next };
  });

  const session = useGitStore.getState().sessions.get(workspaceId);
  // A session still fetching (loadInitial, refresh, init) stores its own.
  if (session?.repoInfo.kind === "repo" && session.status === null && !session.statusFetching) {
    scheduleStatusHintRefresh(workspaceId);
  }
}

/**
 * Install git broadcast listeners once per renderer module instance. The
 * guard makes the call idempotent so HMR module re-execution and repeated
 * test imports do not double-bind the listeners (each `ipcListen` discards
 * its unsubscribe by design — these are process-lifetime subscriptions).
 */
let gitEventSubscriptionsInstalled = false;
export function installGitEventSubscriptions(): void {
  if (gitEventSubscriptionsInstalled) return;
  if (!canUseIpcBridge()) return;
  gitEventSubscriptionsInstalled = true;

  ipcListen("git", "statusChanged", ({ workspaceId, status }) => {
    useGitStore.setState((state) => {
      const session = state.sessions.get(workspaceId);
      if (!session) return state;

      const next = new Map(state.sessions);
      next.set(workspaceId, {
        ...session,
        status,
        statusFetching: false,
        branchInfo: status.branch,
        // Drop persisted directory paths that the new status no longer
        // covers — keeps the header expand/collapse toggle's count
        // honest after background status pushes (commit landed, file
        // discarded via terminal, gitignore added, etc).
        expandedTreeNodes: sanitizeExpandedTreeNodes(session.expandedTreeNodes, status),
        pendingNonFFRetry:
          session.pendingNonFFRetry?.branch === status.branch?.current
            ? session.pendingNonFFRetry
            : null,
      });
      return { sessions: next };
    });
  });

  ipcListen("git", "repoInfoChanged", ({ workspaceId, info }) => {
    applyRepoInfoEvent(workspaceId, info);
  });

  ipcListen("autofetch", "stateChanged", (event) => {
    applyAutofetchEvent(event);
  });

  ipcListen("fs", "changed", ({ workspaceId, changes }) => {
    if (changes.length === 0) return;
    const session = useGitStore.getState().sessions.get(workspaceId);
    if (!session || session.repoInfo.kind !== "repo") return;
    scheduleStatusHintRefresh(workspaceId);
    // `.gitignore` edits (and `.git/info/exclude`) invalidate every
    // cached ignored decision for the workspace. The ignored cache
    // refills lazily on the next viewport check.
    for (const change of changes) {
      if (shouldInvalidateIgnoredCache(change.relPath)) {
        useIgnoredStore.getState().clearWorkspace(workspaceId);
        break;
      }
    }
  });
}
