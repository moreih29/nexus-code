import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  GitBranch,
  GitBranchCreateCommand,
  GitBranchCreateReply,
  GitBranchDeleteCommand,
  GitBranchDeleteReply,
  GitBranchListCommand,
  GitBranchListReply,
  GitCheckoutCommand,
  GitCheckoutReply,
  GitCommitCommand,
  GitCommitReply,
  GitDiffCommand,
  GitDiffReply,
  GitDiscardCommand,
  GitDiscardReply,
  GitFailedEvent,
  GitFileStatusKind,
  GitOptionalPaths,
  GitStageCommand,
  GitStageReply,
  GitStatusCommand,
  GitStatusEntry,
  GitStatusReply,
  GitStatusSummary,
  GitUnstageCommand,
  GitUnstageReply,
  GitWatchStartCommand,
  GitWatchStartedReply,
  GitWatchStopCommand,
  GitWatchStoppedReply,
} from "../../../../shared/src/contracts/generated/git-lifecycle";
import type { GitStatusChangeEvent } from "../../../../shared/src/contracts/generated/git-relay";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export const SOURCE_CONTROL_WATCH_DEBOUNCE_MS = 150;

export type SourceControlStatus = "idle" | "loading" | "ready" | "failed";
export type SourceControlGroupId = "changes" | "staged" | "conflicts";
export type SourceControlOperation =
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
  | "watch_stop";

export type SourceControlBridgeRequest =
  | GitStatusCommand
  | GitBranchListCommand
  | GitCommitCommand
  | GitStageCommand
  | GitUnstageCommand
  | GitDiscardCommand
  | GitCheckoutCommand
  | GitBranchCreateCommand
  | GitBranchDeleteCommand
  | GitDiffCommand
  | GitWatchStartCommand
  | GitWatchStopCommand;

export type SourceControlBridgeResult =
  | GitStatusReply
  | GitBranchListReply
  | GitCommitReply
  | GitStageReply
  | GitUnstageReply
  | GitDiscardReply
  | GitCheckoutReply
  | GitBranchCreateReply
  | GitBranchDeleteReply
  | GitDiffReply
  | GitWatchStartedReply
  | GitWatchStoppedReply
  | GitFailedEvent;

export type SourceControlBridgeEvent = SourceControlBridgeResult | GitStatusChangeEvent;

export interface SourceControlBridgeDisposable {
  dispose(): void;
}

export interface SourceControlBridge {
  invoke(request: SourceControlBridgeRequest): Promise<SourceControlBridgeResult>;
  onEvent(listener: (event: SourceControlBridgeEvent) => void): SourceControlBridgeDisposable;
}

export interface SourceControlFileGroup {
  id: SourceControlGroupId;
  label: string;
  entries: GitStatusEntry[];
}

export interface SourceControlPendingCheckout {
  ref: string;
  dirtyFileCount: number;
}

export interface SourceControlDiffState {
  path: string | null;
  staged: boolean;
  text: string;
  loading: boolean;
}

export interface SourceControlWorkspaceState {
  cwd: string | null;
  status: SourceControlStatus;
  errorMessage: string | null;
  operation: SourceControlOperation | null;
  summary: GitStatusSummary | null;
  branches: GitBranch[];
  watchId: string | null;
  commitMessage: string;
  commitHistory: string[];
  selectedPath: string | null;
  pendingCheckout: SourceControlPendingCheckout | null;
  diff: SourceControlDiffState;
}

export interface SourceControlWorkspaceInput {
  workspaceId: WorkspaceId;
  cwd: string;
}

export interface SourceControlCommitOptions {
  amend?: boolean;
}

export interface SourceControlStoreState {
  workspaceById: Record<string, SourceControlWorkspaceState>;
  applyBridgeEvent(event: SourceControlBridgeEvent): void;
  checkoutBranch(input: SourceControlWorkspaceInput, ref: string, options?: { discardDirty?: boolean }): Promise<void>;
  clearPendingCheckout(workspaceId: WorkspaceId): void;
  commit(input: SourceControlWorkspaceInput, options?: SourceControlCommitOptions): Promise<void>;
  createBranch(input: SourceControlWorkspaceInput, name: string): Promise<void>;
  deleteBranch(input: SourceControlWorkspaceInput, name: string): Promise<void>;
  discardPaths(input: SourceControlWorkspaceInput, paths: string[]): Promise<void>;
  getFileGroups(workspaceId: WorkspaceId): SourceControlFileGroup[];
  getWorkspaceState(workspaceId: WorkspaceId): SourceControlWorkspaceState;
  loadBranches(input: SourceControlWorkspaceInput): Promise<void>;
  refreshStatus(input: SourceControlWorkspaceInput): Promise<void>;
  setCommitMessage(workspaceId: WorkspaceId, message: string): void;
  stagePaths(input: SourceControlWorkspaceInput, paths: string[]): Promise<void>;
  startBridgeSubscription(): void;
  startWatch(input: SourceControlWorkspaceInput): Promise<void>;
  stopBridgeSubscription(): void;
  stopWatch(workspaceId: WorkspaceId): Promise<void>;
  unstagePaths(input: SourceControlWorkspaceInput, paths: string[]): Promise<void>;
  viewDiff(input: SourceControlWorkspaceInput, path: string, staged?: boolean): Promise<void>;
}

export type SourceControlStore = StoreApi<SourceControlStoreState>;

export const EMPTY_GIT_STATUS_SUMMARY: GitStatusSummary = {
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
};

export const EMPTY_SOURCE_CONTROL_WORKSPACE_STATE: SourceControlWorkspaceState = createInitialWorkspaceState();

export function createSourceControlStore(gitBridge: SourceControlBridge): SourceControlStore {
  let subscription: SourceControlBridgeDisposable | null = null;
  let nextRequestSequence = 0;

  const store = createStore<SourceControlStoreState>((set, get) => ({
    workspaceById: {},
    applyBridgeEvent(event) {
      set((state) => applyGitBridgeEventToState(state, event));
    },
    async checkoutBranch(input, ref, options) {
      const workspace = get().workspaceById[input.workspaceId] ?? createInitialWorkspaceState(input.cwd);
      if (!options?.discardDirty && hasDirtyFiles(workspace.summary)) {
        setWorkspaceState(set, input.workspaceId, (current) => ({
          ...current,
          cwd: input.cwd,
          pendingCheckout: {
            ref,
            dirtyFileCount: dirtyFileCount(current.summary),
          },
        }));
        return;
      }

      if (options?.discardDirty) {
        const dirtyPaths = (workspace.summary?.files ?? [])
          .filter((entry) => entry.kind !== "clean")
          .map((entry) => entry.path);
        const gitPaths = nonEmptyGitPaths(dirtyPaths);
        if (gitPaths) {
          await invokeAndApply(get, set, gitBridge, {
            type: "git/lifecycle",
            action: "discard",
            requestId: nextGitRequestId("discard-before-checkout", ++nextRequestSequence),
            workspaceId: input.workspaceId,
            cwd: input.cwd,
            paths: gitPaths,
          });
        }
      }

      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "checkout",
        requestId: nextGitRequestId("checkout", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        ref,
      });
    },
    clearPendingCheckout(workspaceId) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        pendingCheckout: null,
      }));
    },
    async commit(input, options) {
      const workspace = get().workspaceById[input.workspaceId] ?? createInitialWorkspaceState(input.cwd);
      const message = workspace.commitMessage.trim();
      if (!message) {
        return;
      }

      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "commit",
        requestId: nextGitRequestId(options?.amend ? "commit-amend" : "commit", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        message,
        amend: options?.amend === true ? true : undefined,
      });
    },
    async createBranch(input, name) {
      const branchName = name.trim();
      if (!branchName) {
        return;
      }

      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "branch_create",
        requestId: nextGitRequestId("branch-create", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        name: branchName,
      });
    },
    async deleteBranch(input, name) {
      const branchName = name.trim();
      if (!branchName) {
        return;
      }

      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "branch_delete",
        requestId: nextGitRequestId("branch-delete", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        name: branchName,
        force: false,
      });
    },
    async discardPaths(input, paths) {
      const gitPaths = nonEmptyGitPaths(paths);
      if (!gitPaths) {
        return;
      }

      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "discard",
        requestId: nextGitRequestId("discard", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        paths: gitPaths,
      });
    },
    getFileGroups(workspaceId) {
      const workspace = get().workspaceById[workspaceId] ?? EMPTY_SOURCE_CONTROL_WORKSPACE_STATE;
      return getSourceControlFileGroups(workspace.summary);
    },
    getWorkspaceState(workspaceId) {
      return get().workspaceById[workspaceId] ?? EMPTY_SOURCE_CONTROL_WORKSPACE_STATE;
    },
    async loadBranches(input) {
      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "branch_list",
        requestId: nextGitRequestId("branch-list", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
      });
    },
    async refreshStatus(input) {
      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "status",
        requestId: nextGitRequestId("status", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
      });
    },
    setCommitMessage(workspaceId, message) {
      setWorkspaceState(set, workspaceId, (workspace) => ({
        ...workspace,
        commitMessage: message,
      }));
    },
    async stagePaths(input, paths) {
      const gitPaths = nonEmptyGitPaths(paths);
      if (!gitPaths) {
        return;
      }

      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "stage",
        requestId: nextGitRequestId("stage", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        paths: gitPaths,
      });
    },
    startBridgeSubscription() {
      if (subscription) {
        return;
      }

      subscription = gitBridge.onEvent((event) => {
        get().applyBridgeEvent(event);
      });
    },
    async startWatch(input) {
      const current = get().workspaceById[input.workspaceId];
      if (current?.watchId && current.cwd === input.cwd) {
        return;
      }

      const watchId = sourceControlWatchId(input.workspaceId);
      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "watch_start",
        requestId: nextGitRequestId("watch-start", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        watchId,
        debounceMs: SOURCE_CONTROL_WATCH_DEBOUNCE_MS,
      });
    },
    stopBridgeSubscription() {
      subscription?.dispose();
      subscription = null;
    },
    async stopWatch(workspaceId) {
      const current = get().workspaceById[workspaceId];
      if (!current?.watchId) {
        return;
      }

      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "watch_stop",
        requestId: nextGitRequestId("watch-stop", ++nextRequestSequence),
        workspaceId,
        watchId: current.watchId,
      });
    },
    async unstagePaths(input, paths) {
      const gitPaths = nonEmptyGitPaths(paths);
      if (!gitPaths) {
        return;
      }

      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "unstage",
        requestId: nextGitRequestId("unstage", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        paths: gitPaths,
      });
    },
    async viewDiff(input, path, staged = false) {
      setWorkspaceState(set, input.workspaceId, (workspace) => ({
        ...workspace,
        cwd: input.cwd,
        selectedPath: path,
        diff: {
          path,
          staged,
          text: workspace.diff.path === path && workspace.diff.staged === staged ? workspace.diff.text : "",
          loading: true,
        },
      }));

      await invokeAndApply(get, set, gitBridge, {
        type: "git/lifecycle",
        action: "diff",
        requestId: nextGitRequestId("diff", ++nextRequestSequence),
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        staged,
        paths: [path] satisfies GitOptionalPaths,
      });
    },
  }));

  return store;
}

export function getSourceControlFileGroups(summary: GitStatusSummary | null): SourceControlFileGroup[] {
  const groups: SourceControlFileGroup[] = [
    { id: "changes", label: "Changes", entries: [] },
    { id: "staged", label: "Staged Changes", entries: [] },
    { id: "conflicts", label: "Conflicts", entries: [] },
  ];

  for (const entry of summary?.files ?? []) {
    if (isConflictEntry(entry)) {
      groups[2]!.entries.push(entry);
      continue;
    }

    if (isStagedEntry(entry)) {
      groups[1]!.entries.push(entry);
    }

    if (isWorkingTreeEntry(entry)) {
      groups[0]!.entries.push(entry);
    }
  }

  return groups;
}

export function sourceControlStateLabel(summary: GitStatusSummary | null): "clean" | "changed" | "staged" | "conflict" {
  const groups = getSourceControlFileGroups(summary);
  if (groups[2]!.entries.length > 0) {
    return "conflict";
  }
  if (groups[1]!.entries.length > 0) {
    return "staged";
  }
  if (groups[0]!.entries.length > 0) {
    return "changed";
  }
  return "clean";
}

export function hasDirtyFiles(summary: GitStatusSummary | null): boolean {
  return dirtyFileCount(summary) > 0;
}

export function hasStagedFiles(summary: GitStatusSummary | null): boolean {
  return getSourceControlFileGroups(summary)[1]!.entries.length > 0;
}

export function dirtyFileCount(summary: GitStatusSummary | null): number {
  return (summary?.files ?? []).filter((entry) => entry.kind !== "clean").length;
}

export function commitMessageHint(message: string): { subjectLength: number; bodyMaxLength: number } {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const bodyLines = lines.slice(1).filter((line) => line.trim().length > 0);
  return {
    subjectLength: lines[0]?.length ?? 0,
    bodyMaxLength: bodyLines.reduce((max, line) => Math.max(max, line.length), 0),
  };
}

export function statusKindLabel(kind: GitFileStatusKind): string {
  switch (kind) {
    case "modified":
      return "Modified";
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "untracked":
      return "Untracked";
    case "ignored":
      return "Ignored";
    case "conflicted":
      return "Conflict";
    case "clean":
      return "Clean";
  }
}

export function statusKindBadge(kind: GitFileStatusKind): string {
  switch (kind) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "ignored":
      return "I";
    case "conflicted":
      return "!";
    case "clean":
      return "";
  }
}

function createInitialWorkspaceState(cwd: string | null = null): SourceControlWorkspaceState {
  return {
    cwd,
    status: "idle",
    errorMessage: null,
    operation: null,
    summary: null,
    branches: [],
    watchId: null,
    commitMessage: "",
    commitHistory: [],
    selectedPath: null,
    pendingCheckout: null,
    diff: {
      path: null,
      staged: false,
      text: "",
      loading: false,
    },
  };
}

async function invokeAndApply(
  get: StoreApi<SourceControlStoreState>["getState"],
  set: StoreApi<SourceControlStoreState>["setState"],
  gitBridge: SourceControlBridge,
  request: SourceControlBridgeRequest,
): Promise<void> {
  setWorkspaceState(set, request.workspaceId, (workspace) => ({
    ...workspace,
    cwd: "cwd" in request ? request.cwd : workspace.cwd,
    status: request.action === "status" && !workspace.summary ? "loading" : workspace.status,
    errorMessage: null,
    operation: request.action,
  }));

  try {
    const result = await gitBridge.invoke(request);
    get().applyBridgeEvent(result);
  } catch (error) {
    setWorkspaceState(set, request.workspaceId, (workspace) => ({
      ...workspace,
      status: "failed",
      operation: null,
      errorMessage: errorMessage(error, "Unable to complete git operation."),
      diff: request.action === "diff" ? { ...workspace.diff, loading: false } : workspace.diff,
    }));
    throw error;
  }
}

function applyGitBridgeEventToState(
  state: SourceControlStoreState,
  event: SourceControlBridgeEvent,
): Partial<SourceControlStoreState> | SourceControlStoreState {
  const workspace = state.workspaceById[event.workspaceId] ?? createInitialWorkspaceState("cwd" in event ? event.cwd : null);

  if (event.type === "git/relay") {
    return withWorkspaceState(state, event.workspaceId, {
      ...workspace,
      cwd: event.cwd,
      status: "ready",
      errorMessage: null,
      summary: event.summary,
    });
  }

  if (event.action === "failed") {
    return withWorkspaceState(state, event.workspaceId, {
      ...workspace,
      cwd: event.cwd,
      status: "failed",
      operation: null,
      errorMessage: event.message,
      diff: { ...workspace.diff, loading: false },
    });
  }

  switch (event.action) {
    case "status_result":
      return withWorkspaceState(state, event.workspaceId, {
        ...workspace,
        cwd: event.cwd,
        status: "ready",
        errorMessage: null,
        operation: null,
        summary: event.summary,
      });
    case "branch_list_result":
      return withWorkspaceState(state, event.workspaceId, {
        ...workspace,
        cwd: event.cwd,
        errorMessage: null,
        operation: null,
        branches: event.branches,
      });
    case "commit_result":
      return withWorkspaceState(state, event.workspaceId, {
        ...workspace,
        cwd: event.cwd,
        status: "ready",
        errorMessage: null,
        operation: null,
        summary: event.summary,
        commitMessage: "",
        commitHistory: [
          event.commitOid,
          ...workspace.commitHistory.filter((commitOid) => commitOid !== event.commitOid),
        ].slice(0, 20),
      });
    case "stage_result":
    case "unstage_result":
    case "discard_result":
      return withWorkspaceState(state, event.workspaceId, {
        ...workspace,
        cwd: event.cwd,
        status: "ready",
        errorMessage: null,
        operation: null,
        summary: event.summary,
      });
    case "checkout_result":
      return withWorkspaceState(state, event.workspaceId, {
        ...workspace,
        cwd: event.cwd,
        status: "ready",
        errorMessage: null,
        operation: null,
        summary: event.summary,
        pendingCheckout: null,
      });
    case "branch_create_result":
    case "branch_delete_result":
      return withWorkspaceState(state, event.workspaceId, {
        ...workspace,
        cwd: event.cwd,
        errorMessage: null,
        operation: null,
        branches: event.branches,
      });
    case "diff_result":
      return withWorkspaceState(state, event.workspaceId, {
        ...workspace,
        cwd: event.cwd,
        errorMessage: null,
        operation: null,
        diff: {
          path: event.paths[0] ?? workspace.diff.path,
          staged: event.staged,
          text: event.diff,
          loading: false,
        },
      });
    case "watch_started":
      return withWorkspaceState(state, event.workspaceId, {
        ...workspace,
        cwd: event.cwd,
        errorMessage: null,
        operation: null,
        watchId: event.watchId,
      });
    case "watch_stopped":
      return withWorkspaceState(state, event.workspaceId, {
        ...workspace,
        operation: null,
        watchId: workspace.watchId === event.watchId ? null : workspace.watchId,
      });
  }
}

function setWorkspaceState(
  set: StoreApi<SourceControlStoreState>["setState"],
  workspaceId: WorkspaceId,
  update: (workspace: SourceControlWorkspaceState) => SourceControlWorkspaceState,
): void {
  set((state) => ({
    workspaceById: {
      ...state.workspaceById,
      [workspaceId]: update(state.workspaceById[workspaceId] ?? createInitialWorkspaceState()),
    },
  }));
}

function withWorkspaceState(
  state: SourceControlStoreState,
  workspaceId: WorkspaceId,
  workspace: SourceControlWorkspaceState,
): SourceControlStoreState {
  return {
    ...state,
    workspaceById: {
      ...state.workspaceById,
      [workspaceId]: workspace,
    },
  };
}

function nonEmptyGitPaths(paths: string[]): [string, ...string[]] | null {
  const normalized = paths.map((path) => path.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }
  return normalized as [string, ...string[]];
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

function sourceControlWatchId(workspaceId: WorkspaceId): string {
  return `source-control-${workspaceId}`;
}

function nextGitRequestId(action: string, sequence: number): string {
  return `git-${action}-${Date.now()}-${sequence}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
