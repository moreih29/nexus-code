import type { GitAutofetchStateChanged, RepoInfo } from "../../../../shared/git/types";
import { canUseIpcBridge, ipcListen } from "../../../ipc/client";
import { scheduleStatusHintRefresh } from "./draft-persistence";
import { shouldInvalidateIgnoredCache, useIgnoredStore } from "./ignored";
import { useGitStore } from "./index";
import { sanitizeExpandedTreeNodes } from "./panel-ui";
import { withSlashTopLevel } from "./store-helpers";

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
  if (session?.repoInfo.kind === "repo" && session.status === null && !session.statusFetching) {
    scheduleStatusHintRefresh(workspaceId);
  }
}

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
    for (const change of changes) {
      if (shouldInvalidateIgnoredCache(change.relPath)) {
        useIgnoredStore.getState().clearWorkspace(workspaceId);
        break;
      }
    }
  });
}
