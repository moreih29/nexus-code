import { createStore, type StoreApi } from "zustand/vanilla";

import type { WorkspaceGitBadgeStatus } from "../../../../shared/src/contracts/editor/editor-bridge";
import type {
  GitBranch,
  GitBranchListReply,
  GitFailedEvent,
  GitFileStatusKind,
  GitLifecycleAction,
  GitStatusEntry,
  GitStatusReply,
  GitStatusSummary,
  GitWatchStartedReply,
  GitWatchStoppedReply,
} from "../../../../shared/src/contracts/generated/git-lifecycle";
import type { GitStatusChangeEvent } from "../../../../shared/src/contracts/generated/git-relay";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export type GitServiceStatus = "idle" | "loading" | "ready" | "failed";
export type GitBridgeConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";
export type GitSidecarStatus = "unknown" | "starting" | "ready" | "unavailable" | "failed";
export type GitServiceOperation = Extract<
  GitLifecycleAction,
  | "status"
  | "branch_list"
  | "commit"
  | "stage"
  | "unstage"
  | "discard"
  | "checkout"
  | "branch_create"
  | "branch_delete"
  | "diff"
  | "watch_start"
  | "watch_stop"
>;

export interface IGitService {
  workspaceId: WorkspaceId | null;
  cwd: string | null;
  status: GitServiceStatus;
  operation: GitServiceOperation | null;
  summary: GitStatusSummary | null;
  branches: GitBranch[];
  pathStatusByPath: Record<string, GitStatusEntry>;
  pathBadgeByPath: Record<string, WorkspaceGitBadgeStatus>;
  selectedPaths: string[];
  watchId: string | null;
  bridgeStatus: GitBridgeConnectionStatus;
  bridgeStatusMessage: string | null;
  sidecarStatus: GitSidecarStatus;
  sidecarStatusMessage: string | null;
  errorMessage: string | null;
  lastStatusAt: string | null;
  setStatus(status: GitServiceStatus): void;
  setOperation(operation: GitServiceOperation | null): void;
  applySummary(workspaceId: WorkspaceId, summary: GitStatusSummary): void;
  applyStatusResult(result: GitStatusReply | GitStatusChangeEvent): void;
  setBranches(workspaceId: WorkspaceId, branches: GitBranch[]): void;
  applyBranchListResult(result: GitBranchListReply): void;
  setError(errorMessage: string): void;
  applyFailedEvent(event: GitFailedEvent): void;
  selectPath(path: string | null): void;
  selectPaths(paths: string[]): void;
  togglePathSelection(path: string): void;
  clearSelection(): void;
  getCurrentBranch(): GitBranch | null;
  getBranchName(): string | null;
  getPathStatus(path: string): GitStatusEntry | null;
  getPathBadge(path: string): WorkspaceGitBadgeStatus | null;
  setBridgeStatus(status: GitBridgeConnectionStatus, message?: string | null): void;
  setSidecarStatus(status: GitSidecarStatus, message?: string | null): void;
  applyWatchStarted(result: GitWatchStartedReply): void;
  applyWatchStopped(result: GitWatchStoppedReply): void;
  clear(): void;
}

export type GitServiceStore = StoreApi<IGitService>;
export type GitServiceState = Pick<
  IGitService,
  | "workspaceId"
  | "cwd"
  | "status"
  | "operation"
  | "summary"
  | "branches"
  | "pathStatusByPath"
  | "pathBadgeByPath"
  | "selectedPaths"
  | "watchId"
  | "bridgeStatus"
  | "bridgeStatusMessage"
  | "sidecarStatus"
  | "sidecarStatusMessage"
  | "errorMessage"
  | "lastStatusAt"
>;

const DEFAULT_GIT_STATE: GitServiceState = {
  workspaceId: null,
  cwd: null,
  status: "idle",
  operation: null,
  summary: null,
  branches: [],
  pathStatusByPath: {},
  pathBadgeByPath: {},
  selectedPaths: [],
  watchId: null,
  bridgeStatus: "disconnected",
  bridgeStatusMessage: null,
  sidecarStatus: "unknown",
  sidecarStatusMessage: null,
  errorMessage: null,
  lastStatusAt: null,
};

export function createGitService(
  initialState: Partial<GitServiceState> = {},
): GitServiceStore {
  return createStore<IGitService>((set, get) => ({
    ...DEFAULT_GIT_STATE,
    ...initialState,
    setStatus(status) {
      set({ status });
    },
    setOperation(operation) {
      set({ operation });
    },
    applySummary(workspaceId, summary) {
      set({
        workspaceId,
        summary,
        status: "ready",
        operation: null,
        errorMessage: null,
        ...derivePathState(summary),
      });
    },
    applyStatusResult(result) {
      set({
        workspaceId: result.workspaceId,
        cwd: result.cwd,
        watchId: result.type === "git/relay" ? result.watchId : get().watchId,
        summary: result.summary,
        status: "ready",
        operation: null,
        errorMessage: null,
        lastStatusAt: result.type === "git/relay" ? result.changedAt : result.generatedAt,
        bridgeStatus: result.type === "git/relay" ? "connected" : get().bridgeStatus,
        ...derivePathState(result.summary),
      });
    },
    setBranches(workspaceId, branches) {
      set({ workspaceId, branches });
    },
    applyBranchListResult(result) {
      set({
        workspaceId: result.workspaceId,
        cwd: result.cwd,
        branches: result.branches,
        operation: null,
        errorMessage: null,
      });
    },
    setError(errorMessage) {
      set({ status: "failed", operation: null, errorMessage });
    },
    applyFailedEvent(event) {
      set({
        workspaceId: event.workspaceId,
        cwd: event.cwd,
        status: "failed",
        operation: null,
        errorMessage: event.message,
        lastStatusAt: event.failedAt,
      });
    },
    selectPath(path) {
      set({ selectedPaths: path ? [path] : [] });
    },
    selectPaths(paths) {
      set({ selectedPaths: uniquePaths(paths) });
    },
    togglePathSelection(path) {
      set((state) => ({
        selectedPaths: state.selectedPaths.includes(path)
          ? state.selectedPaths.filter((selectedPath) => selectedPath !== path)
          : [...state.selectedPaths, path],
      }));
    },
    clearSelection() {
      set({ selectedPaths: [] });
    },
    getCurrentBranch() {
      const state = get();
      const branchName = state.summary?.branch ?? null;
      return (
        (branchName ? state.branches.find((branch) => branch.name === branchName) : null) ??
        state.branches.find((branch) => branch.current) ??
        null
      );
    },
    getBranchName() {
      const state = get();
      return state.summary?.branch ?? state.branches.find((branch) => branch.current)?.name ?? null;
    },
    getPathStatus(path) {
      return get().pathStatusByPath[path] ?? null;
    },
    getPathBadge(path) {
      return get().pathBadgeByPath[path] ?? null;
    },
    setBridgeStatus(status, message = null) {
      set({ bridgeStatus: status, bridgeStatusMessage: message });
    },
    setSidecarStatus(status, message = null) {
      set({ sidecarStatus: status, sidecarStatusMessage: message });
    },
    applyWatchStarted(result) {
      set({
        workspaceId: result.workspaceId,
        cwd: result.cwd,
        watchId: result.watchId,
        operation: null,
        bridgeStatus: "connected",
        bridgeStatusMessage: null,
        errorMessage: null,
      });
    },
    applyWatchStopped(result) {
      set((state) => ({
        workspaceId: result.workspaceId,
        watchId: state.watchId === result.watchId ? null : state.watchId,
        operation: null,
      }));
    },
    clear() {
      set(DEFAULT_GIT_STATE);
    },
  }));
}

function derivePathState(summary: GitStatusSummary): Pick<GitServiceState, "pathStatusByPath" | "pathBadgeByPath"> {
  const pathStatusByPath: Record<string, GitStatusEntry> = {};
  const pathBadgeByPath: Record<string, WorkspaceGitBadgeStatus> = {};

  for (const entry of summary.files) {
    pathStatusByPath[entry.path] = entry;
    const badge = gitBadgeForEntry(entry);
    if (badge !== null && badge !== "clean") {
      pathBadgeByPath[entry.path] = badge;
    }
  }

  return { pathStatusByPath, pathBadgeByPath };
}

function gitBadgeForEntry(entry: GitStatusEntry): WorkspaceGitBadgeStatus | null {
  if (isConflictEntry(entry)) {
    return "conflicted";
  }

  if (isStagedEntry(entry) && !isWorkingTreeEntry(entry)) {
    return "staged";
  }

  return gitKindToBadge(entry.kind);
}

function gitKindToBadge(kind: GitFileStatusKind): WorkspaceGitBadgeStatus | null {
  switch (kind) {
    case "modified":
    case "added":
    case "deleted":
    case "renamed":
    case "untracked":
    case "ignored":
    case "conflicted":
    case "clean":
      return kind;
    case "copied":
      return "added";
  }
}

function isConflictEntry(entry: GitStatusEntry): boolean {
  return entry.kind === "conflicted" || entry.indexStatus === "U" || entry.workTreeStatus === "U";
}

function isStagedEntry(entry: GitStatusEntry): boolean {
  return entry.status !== "??" && entry.indexStatus.trim() !== "" && entry.indexStatus !== "?";
}

function isWorkingTreeEntry(entry: GitStatusEntry): boolean {
  return entry.status === "??" || entry.workTreeStatus.trim() !== "";
}

function uniquePaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths));
}
