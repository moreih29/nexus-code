import type { GitCommitOptions, LogEntry } from "../../../../shared/git/types";
import { DEFAULT_GIT_PANEL_STATE } from "../../../../shared/git/types";
import { ipcStream } from "../../../ipc/client";
import type { GitOperationKind, GitSession } from "./types";

export function createDefaultSession(overrides: Partial<GitSession> = {}): GitSession {
  return {
    repoInfo: { kind: "detecting" },
    status: null,
    statusFetching: false,
    branchInfo: null,
    expandedGroups: { ...DEFAULT_GIT_PANEL_STATE.expandedGroups },
    expandedTreeNodes: { ...DEFAULT_GIT_PANEL_STATE.expandedTreeNodes },
    commitOptions: { ...DEFAULT_GIT_PANEL_STATE.commitOptions },
    autofetchIntervalMin: DEFAULT_GIT_PANEL_STATE.autofetchIntervalMin,
    autofetchManualPaused: DEFAULT_GIT_PANEL_STATE.autofetchManualPaused,
    autofetchFetching: false,
    autofetchConsecutiveFailures: 0,
    autofetchLastError: null,
    autofetchPausedBannerVisible: false,
    panelSegment: DEFAULT_GIT_PANEL_STATE.panelSegment,
    historyRef: DEFAULT_GIT_PANEL_STATE.historyRef,
    historyScope: DEFAULT_GIT_PANEL_STATE.historyScope,
    inFlightOp: null,
    lastError: null,
    pendingNonFFRetry: null,
    ...overrides,
  };
}

export function isStatusFetchingOperation(kind: GitOperationKind): boolean {
  return kind === "refresh" || kind === "init";
}

export async function collectRecentCommits(
  workspaceId: string,
  signal?: AbortSignal,
  ref?: string,
): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  const handle = ipcStream(
    "git",
    "log",
    { workspaceId, limit: 20, ref: ref?.trim() || undefined },
    signal ? { signal } : {},
  );
  handle.onProgress((chunk) => {
    entries.push(...chunk.entries);
  });
  await handle.promise;
  return entries.slice(0, 20);
}

export function resolveCommitOptions(
  workspaceId: string,
  overrides: Partial<GitCommitOptions>,
  sessions: Map<string, GitSession>,
): GitCommitOptions {
  const sticky = sessions.get(workspaceId)?.commitOptions ?? DEFAULT_GIT_PANEL_STATE.commitOptions;
  return {
    sign: overrides.sign ?? sticky.sign,
    signoff: overrides.signoff ?? sticky.signoff,
    noVerify: overrides.noVerify ?? sticky.noVerify,
  };
}
