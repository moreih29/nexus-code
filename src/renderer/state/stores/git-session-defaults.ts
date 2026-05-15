/**
 * Pure session-shape helpers extracted from `git.ts`. Each function here
 * either constructs a fresh `GitSession` value, classifies an operation
 * kind, or merges commit options against the per-workspace sticky defaults.
 *
 * `collectRecentCommits` does perform IPC (`ipcStream("git", "log")`) but
 * belongs in the same module because it produces the same canonical
 * `LogEntry[]` shape that callers use to seed pickers — the surrounding
 * store does not own that shape and shouldn't grow a dedicated method.
 */
import type { GitCommitOptions, LogEntry } from "../../../shared/types/git";
import { DEFAULT_GIT_PANEL_STATE } from "../../../shared/types/git";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL } from "../../../shared/types/panel";
import { ipcStream } from "../../ipc/client";
import type { GitOperationKind, GitSession } from "./git";

/**
 * Builds a fresh `GitSession` with the project's defaults, allowing
 * caller-supplied overrides to override individual fields. Used when the
 * store sees a workspaceId for the first time.
 */
export function createDefaultSession(overrides: Partial<GitSession> = {}): GitSession {
  return {
    repoInfo: { kind: "detecting" },
    status: null,
    statusFetching: false,
    branchInfo: null,
    commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
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
    viewMode: DEFAULT_VIEW_OPTIONS_BY_PANEL.git.viewMode,
    compactFolders: DEFAULT_VIEW_OPTIONS_BY_PANEL.git.compactFolders,
    inFlightOp: null,
    lastError: null,
    pendingNonFFRetry: null,
    ...overrides,
  };
}

/**
 * Status-fetching operations drive the skeleton/loading affordance in the
 * panel in addition to the generic `inFlightOp` indicator.
 */
export function isStatusFetchingOperation(kind: GitOperationKind): boolean {
  return kind === "refresh" || kind === "init";
}

/**
 * Collects a bounded recent commit list from the existing git.log stream so
 * the ref picker can include immutable commit targets without a bespoke IPC.
 */
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

/**
 * Merges per-workspace sticky commit options with one-off overrides.
 */
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
