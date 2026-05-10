import { create } from "zustand";
import {
  GIT_COMMIT_DRAFT_SAVE_DEBOUNCE_MS,
  GIT_STATUS_HINT_DEBOUNCE_MS,
} from "../../../shared/timing-constants";
import type {
  BranchInfo,
  BranchList,
  CommitResult,
  GitActionHint,
  GitExpandedGroupKey,
  GitExpandedGroups,
  GitExpandedTreeNodes,
  GitPanelStateUpdate,
  GitStatus,
  PullResult,
  PushResult,
  RepoInfo,
} from "../../../shared/types/git";
import { DEFAULT_GIT_PANEL_STATE } from "../../../shared/types/git";
import type { ViewMode } from "../../../shared/types/panel";
import { DEFAULT_VIEW_OPTIONS_BY_PANEL } from "../../../shared/types/panel";
import { ipcCall, ipcListen } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../lifecycle/workspace-cleanup";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GitOperationKind =
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "fetch"
  | "pull"
  | "push"
  | "stash"
  | "stashPop"
  | "checkout"
  | "checkoutTracking"
  | "createBranch"
  | "refresh"
  | "init";

export interface GitInFlightOp {
  kind: GitOperationKind;
  startedAt: number;
}

export interface GitStoreError {
  kind: string;
  message: string;
  details?: string;
  operation?: GitOperationKind;
  /**
   * Actionable next-step payload populated from `GitError.hint` when the
   * main process emits a typed preflight failure. The Source Control panel
   * uses this to render one-click recovery affordances (Publish branch,
   * Track remote, Make initial commit) instead of a raw error toast.
   */
  hint?: GitActionHint;
}

export interface GitSession {
  repoInfo: RepoInfo;
  status: GitStatus | null;
  statusFetching: boolean;
  branchInfo: BranchInfo | null;
  commitDraft: string;
  expandedGroups: GitExpandedGroups;
  expandedTreeNodes: GitExpandedTreeNodes;
  viewMode: ViewMode;
  compactFolders: boolean;
  inFlightOp: GitInFlightOp | null;
  lastError: GitStoreError | null;
}

export interface CommitOptions {
  message?: string;
  amend?: boolean;
  signoff?: boolean;
}

interface GitState {
  sessions: Map<string, GitSession>;
  loadInitial: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  init: (workspaceId: string) => Promise<RepoInfo | undefined>;
  stage: (workspaceId: string, relPaths: string[]) => Promise<void>;
  unstage: (workspaceId: string, relPaths: string[]) => Promise<void>;
  discard: (workspaceId: string, relPaths: string[], source?: GitExpandedGroupKey) => Promise<void>;
  commit: (workspaceId: string, options?: CommitOptions) => Promise<CommitResult | undefined>;
  fetch: (workspaceId: string, remote?: string) => Promise<void>;
  pull: (workspaceId: string) => Promise<PullResult | undefined>;
  push: (
    workspaceId: string,
    options?: { force?: boolean; publish?: boolean },
  ) => Promise<PushResult | undefined>;
  stash: (workspaceId: string, message?: string) => Promise<void>;
  stashPop: (workspaceId: string) => Promise<void>;
  checkout: (workspaceId: string, ref: string) => Promise<void>;
  checkoutTracking: (workspaceId: string, remoteRef: string) => Promise<void>;
  createBranch: (workspaceId: string, name: string, checkout?: boolean) => Promise<void>;
  listBranches: (workspaceId: string, signal?: AbortSignal) => Promise<BranchList | undefined>;
  setCommitDraft: (workspaceId: string, text: string) => void;
  flushCommitDraft: (workspaceId: string) => void;
  flushAllCommitDrafts: () => void;
  setExpandedGroup: (workspaceId: string, group: GitExpandedGroupKey, expanded: boolean) => void;
  setViewMode: (workspaceId: string, viewMode: ViewMode) => void;
  setCompactFolders: (workspaceId: string, compactFolders: boolean) => void;
  toggleExpandedTreeNode: (workspaceId: string, groupKey: GitExpandedGroupKey, relPath: string) => void;
  closeAllForWorkspace: (workspaceId: string) => void;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const controllers = new Map<string, AbortController>();
const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDraftSaves = new Map<string, string>();
const statusHintTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useGitStore = create<GitState>((set, get) => {
  registerWorkspaceCleanup((id) => {
    get().closeAllForWorkspace(id);
  });

  /**
   * Update an existing session only. IPC broadcasts use this path so an
   * event for a workspace without an active session is dropped silently.
   */
  function updateExistingSession(
    workspaceId: string,
    updater: (session: GitSession) => GitSession,
  ): void {
    set((state) => {
      const session = state.sessions.get(workspaceId);
      if (!session) return state;

      const next = new Map(state.sessions);
      next.set(workspaceId, updater(session));
      return { sessions: next };
    });
  }

  /**
   * Update a session, creating a default one first when a user action
   * arrives before the panel has been seeded.
   */
  function upsertSession(workspaceId: string, updater: (session: GitSession) => GitSession): void {
    set((state) => {
      const session = state.sessions.get(workspaceId) ?? createDefaultSession();
      const next = new Map(state.sessions);
      next.set(workspaceId, updater(session));
      return { sessions: next };
    });
  }

  /**
   * Mark a workspace operation as running and replace any previous op
   * controller so cleanup can abort the current unit of work.
   */
  function beginOperation(workspaceId: string, kind: GitOperationKind): AbortController {
    const prior = controllers.get(workspaceId);
    if (prior) {
      prior.abort();
      controllers.delete(workspaceId);
    }

    const ctrl = new AbortController();
    controllers.set(workspaceId, ctrl);

    upsertSession(workspaceId, (session) => {
      const priorWasStatusFetch =
        session.inFlightOp?.kind === "refresh" || session.inFlightOp?.kind === "init";
      return {
        ...session,
        statusFetching: isStatusFetchingOperation(kind)
          ? true
          : priorWasStatusFetch
            ? false
            : session.statusFetching,
        inFlightOp: { kind, startedAt: Date.now() },
        lastError: null,
      };
    });

    return ctrl;
  }

  /**
   * Finish the current operation only when it still owns the workspace's
   * controller; stale promises from aborted operations are ignored.
   */
  function finishOperation(
    workspaceId: string,
    kind: GitOperationKind,
    ctrl: AbortController,
  ): void {
    if (controllers.get(workspaceId) !== ctrl) return;

    controllers.delete(workspaceId);
    updateExistingSession(workspaceId, (session) => ({
      ...session,
      statusFetching: isStatusFetchingOperation(kind) ? false : session.statusFetching,
      inFlightOp: null,
    }));
  }

  /**
   * Record an operation error on the matching session unless the operation
   * was superseded or intentionally aborted.
   */
  function failOperation(
    workspaceId: string,
    kind: GitOperationKind,
    ctrl: AbortController,
    error: unknown,
  ): void {
    if (controllers.get(workspaceId) !== ctrl || isAbortError(error)) return;

    updateExistingSession(workspaceId, (session) => ({
      ...session,
      statusFetching: isStatusFetchingOperation(kind) ? false : session.statusFetching,
      lastError: gitStoreErrorFromUnknown(error, kind),
    }));
  }

  /**
   * Shared operation wrapper: set `inFlightOp`, run the typed IPC call,
   * normalize errors into state, then clear the operation on completion.
   */
  async function runOperation<T>(
    workspaceId: string,
    kind: GitOperationKind,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const ctrl = beginOperation(workspaceId, kind);
    try {
      return await run(ctrl.signal);
    } catch (error) {
      failOperation(workspaceId, kind, ctrl, error);
      return undefined;
    } finally {
      finishOperation(workspaceId, kind, ctrl);
    }
  }

  /**
   * Persist the commit draft immediately after successful commit so a
   * pending debounce cannot later restore the pre-commit draft.
   */
  function clearCommitDraftAfterCommit(workspaceId: string): void {
    cancelCommitDraftSave(workspaceId);
    updateExistingSession(workspaceId, (session) => ({ ...session, commitDraft: "" }));
    persistPanelState(workspaceId, { commitDraft: "" });
  }

  return {
    sessions: new Map(),

    async loadInitial(workspaceId) {
      if (get().sessions.has(workspaceId)) return;

      set((state) => {
        if (state.sessions.has(workspaceId)) return state;
        const next = new Map(state.sessions);
        next.set(workspaceId, createDefaultSession({ statusFetching: true }));
        return { sessions: next };
      });

      const [repoInfoResult, statusResult, panelStateResult, viewOptionsResult] =
        await Promise.allSettled([
          ipcCall("git", "getRepoInfo", { workspaceId }),
          ipcCall("git", "getStatus", { workspaceId }),
          ipcCall("git", "getPanelState", { workspaceId }),
          ipcCall("panel", "getViewOptions", { workspaceId, panelKind: "git" }),
        ]);

      updateExistingSession(workspaceId, (session) => {
        const firstError = firstRejectedReason(
          repoInfoResult,
          statusResult,
          panelStateResult,
          viewOptionsResult,
        );
        return {
          ...session,
          repoInfo: repoInfoResult.status === "fulfilled" ? repoInfoResult.value : session.repoInfo,
          status: statusResult.status === "fulfilled" ? statusResult.value : session.status,
          statusFetching: false,
          branchInfo:
            statusResult.status === "fulfilled" ? statusResult.value.branch : session.branchInfo,
          commitDraft:
            panelStateResult.status === "fulfilled"
              ? panelStateResult.value.commitDraft
              : session.commitDraft,
          expandedGroups:
            panelStateResult.status === "fulfilled"
              ? { ...panelStateResult.value.expandedGroups }
              : session.expandedGroups,
          expandedTreeNodes:
            panelStateResult.status === "fulfilled"
              ? { ...panelStateResult.value.expandedTreeNodes }
              : session.expandedTreeNodes,
          viewMode:
            viewOptionsResult.status === "fulfilled"
              ? viewOptionsResult.value.viewMode
              : session.viewMode,
          compactFolders:
            viewOptionsResult.status === "fulfilled"
              ? viewOptionsResult.value.compactFolders
              : session.compactFolders,
          lastError: firstError ? gitStoreErrorFromUnknown(firstError) : null,
        };
      });
    },

    async refresh(workspaceId) {
      await runOperation(workspaceId, "refresh", async (signal) => {
        const repoInfo = await ipcCall("git", "refreshDetection", { workspaceId }, { signal });
        const status = await ipcCall("git", "getStatus", { workspaceId }, { signal });
        updateExistingSession(workspaceId, (session) => ({
          ...session,
          repoInfo,
          status,
          statusFetching: false,
          branchInfo: status.branch,
          lastError: null,
        }));
      });
    },

    async init(workspaceId) {
      return runOperation(workspaceId, "init", async (signal) => {
        const repoInfo = await ipcCall("git", "init", { workspaceId }, { signal });
        const status = await ipcCall("git", "getStatus", { workspaceId }, { signal });
        updateExistingSession(workspaceId, (session) => ({
          ...session,
          repoInfo,
          status,
          statusFetching: false,
          branchInfo: status.branch,
          lastError: null,
        }));
        return repoInfo;
      });
    },

    async stage(workspaceId, relPaths) {
      if (relPaths.length === 0) return;
      await runOperation(workspaceId, "stage", (signal) =>
        ipcCall("git", "stage", { workspaceId, relPaths }, { signal }),
      );
    },

    async unstage(workspaceId, relPaths) {
      if (relPaths.length === 0) return;
      await runOperation(workspaceId, "unstage", (signal) =>
        ipcCall("git", "unstage", { workspaceId, relPaths }, { signal }),
      );
    },

    async discard(workspaceId, relPaths, source) {
      if (relPaths.length === 0) return;
      await runOperation(workspaceId, "discard", (signal) =>
        ipcCall("git", "discardChanges", { workspaceId, relPaths, source }, { signal }),
      );
    },

    async commit(workspaceId, options = {}) {
      const message = options.message ?? get().sessions.get(workspaceId)?.commitDraft ?? "";
      const result = await runOperation(workspaceId, "commit", (signal) =>
        ipcCall(
          "git",
          "commit",
          {
            workspaceId,
            message,
            amend: options.amend,
            signoff: options.signoff,
          },
          { signal },
        ),
      );

      if (result) {
        clearCommitDraftAfterCommit(workspaceId);
      }

      return result;
    },

    async fetch(workspaceId, remote) {
      await runOperation(workspaceId, "fetch", (signal) =>
        ipcCall("git", "fetch", { workspaceId, remote }, { signal }),
      );
    },

    async pull(workspaceId) {
      return runOperation(workspaceId, "pull", (signal) =>
        ipcCall("git", "pull", { workspaceId }, { signal }),
      );
    },

    async push(workspaceId, options = {}) {
      return runOperation(workspaceId, "push", (signal) =>
        ipcCall(
          "git",
          "push",
          { workspaceId, force: options.force, publish: options.publish },
          { signal },
        ),
      );
    },

    async stash(workspaceId, message) {
      await runOperation(workspaceId, "stash", (signal) =>
        ipcCall("git", "stash", { workspaceId, message }, { signal }),
      );
    },

    async stashPop(workspaceId) {
      await runOperation(workspaceId, "stashPop", (signal) =>
        ipcCall("git", "stashPop", { workspaceId }, { signal }),
      );
    },

    async checkout(workspaceId, ref) {
      await runOperation(workspaceId, "checkout", (signal) =>
        ipcCall("git", "checkout", { workspaceId, ref }, { signal }),
      );
    },

    async checkoutTracking(workspaceId, remoteRef) {
      await runOperation(workspaceId, "checkoutTracking", (signal) =>
        ipcCall("git", "checkoutTracking", { workspaceId, remoteRef }, { signal }),
      );
    },

    async createBranch(workspaceId, name, checkout) {
      await runOperation(workspaceId, "createBranch", (signal) =>
        ipcCall("git", "createBranch", { workspaceId, name, checkout }, { signal }),
      );
    },

    async listBranches(workspaceId, signal) {
      try {
        return await ipcCall("git", "listBranches", { workspaceId }, signal ? { signal } : {});
      } catch (error) {
        if (signal?.aborted) return undefined;
        throw error;
      }
    },

    setCommitDraft(workspaceId, text) {
      upsertSession(workspaceId, (session) => ({ ...session, commitDraft: text }));
      scheduleCommitDraftSave(workspaceId, text);
    },

    flushCommitDraft(workspaceId) {
      flushCommitDraftSave(workspaceId);
    },

    flushAllCommitDrafts() {
      flushAllCommitDraftSaves();
    },

    setExpandedGroup(workspaceId, group, expanded) {
      const session = get().sessions.get(workspaceId);
      if (!session) return;

      const expandedGroups = { ...session.expandedGroups, [group]: expanded };
      updateExistingSession(workspaceId, (cur) => ({ ...cur, expandedGroups }));
      persistPanelState(workspaceId, { expandedGroups });
    },

    setViewMode(workspaceId, viewMode) {
      updateExistingSession(workspaceId, (cur) => ({ ...cur, viewMode }));
      persistViewOptions(workspaceId, { viewMode });
    },

    setCompactFolders(workspaceId, compactFolders) {
      updateExistingSession(workspaceId, (cur) => ({ ...cur, compactFolders }));
      persistViewOptions(workspaceId, { compactFolders });
    },

    toggleExpandedTreeNode(workspaceId, groupKey, relPath) {
      const session = get().sessions.get(workspaceId);
      if (!session) return;

      const current = session.expandedTreeNodes[groupKey];
      const isExpanded = current.includes(relPath);
      const next = isExpanded ? current.filter((p) => p !== relPath) : [...current, relPath];
      const expandedTreeNodes = { ...session.expandedTreeNodes, [groupKey]: next };
      updateExistingSession(workspaceId, (cur) => ({ ...cur, expandedTreeNodes }));
      persistPanelState(workspaceId, { expandedTreeNodes });
    },

    closeAllForWorkspace(workspaceId) {
      const ctrl = controllers.get(workspaceId);
      if (ctrl) {
        ctrl.abort();
        controllers.delete(workspaceId);
      }
      cancelCommitDraftSave(workspaceId);
      cancelStatusHintRefresh(workspaceId);
      set((state) => {
        if (!state.sessions.has(workspaceId)) return state;
        const next = new Map(state.sessions);
        next.delete(workspaceId);
        return { sessions: next };
      });
    },
  };
});

installGitEventSubscriptions();
installCommitDraftFlushListeners();

// ---------------------------------------------------------------------------
// Selector helper
// ---------------------------------------------------------------------------

export function useGitSession(workspaceId: string): GitSession | undefined {
  return useGitStore((s) => s.sessions.get(workspaceId));
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh session object. Nested objects are cloned so sessions never
 * share mutable panel state.
 */
function createDefaultSession(overrides: Partial<GitSession> = {}): GitSession {
  return {
    repoInfo: { kind: "detecting" },
    status: null,
    statusFetching: false,
    branchInfo: null,
    commitDraft: DEFAULT_GIT_PANEL_STATE.commitDraft,
    expandedGroups: { ...DEFAULT_GIT_PANEL_STATE.expandedGroups },
    expandedTreeNodes: { ...DEFAULT_GIT_PANEL_STATE.expandedTreeNodes },
    viewMode: DEFAULT_VIEW_OPTIONS_BY_PANEL.git.viewMode,
    compactFolders: DEFAULT_VIEW_OPTIONS_BY_PANEL.git.compactFolders,
    inFlightOp: null,
    lastError: null,
    ...overrides,
  };
}

/**
 * Status-fetching operations drive the skeleton/loading affordance in the
 * panel in addition to the generic `inFlightOp` indicator.
 */
function isStatusFetchingOperation(kind: GitOperationKind): boolean {
  return kind === "refresh" || kind === "init";
}

/**
 * Keep renderer-only side effects from firing in unit tests or non-browser
 * contexts where the preload bridge is not installed.
 */
function canUseIpcBridge(): boolean {
  return typeof window !== "undefined" && "ipc" in window;
}

/**
 * Persist panel-state updates through the git channel. Failures are logged
 * but do not roll back local UI state.
 */
function persistPanelState(workspaceId: string, update: GitPanelStateUpdate): void {
  if (!canUseIpcBridge()) return;

  ipcCall("git", "setPanelState", { workspaceId, ...update }).catch((error: unknown) => {
    console.error("[git] setPanelState failed", error);
  });
}

/**
 * Persist panel view-options through the panel channel. Failures are logged
 * but do not roll back local UI state.
 */
function persistViewOptions(
  workspaceId: string,
  partial: { viewMode?: ViewMode; compactFolders?: boolean },
): void {
  if (!canUseIpcBridge()) return;

  ipcCall("panel", "setViewOptions", { workspaceId, panelKind: "git", ...partial }).catch(
    (error: unknown) => {
      console.error("[git] setViewOptions failed", error);
    },
  );
}

/**
 * Schedule a per-workspace commit-draft write; repeated keystrokes reset
 * the same timer so only the final value reaches storage.
 */
function scheduleCommitDraftSave(workspaceId: string, commitDraft: string): void {
  pendingDraftSaves.set(workspaceId, commitDraft);

  const existing = draftSaveTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
  }

  const handle = setTimeout(() => {
    flushCommitDraftSave(workspaceId);
  }, GIT_COMMIT_DRAFT_SAVE_DEBOUNCE_MS);
  draftSaveTimers.set(workspaceId, handle);
}

/**
 * Cancel the pending draft persistence for a workspace without writing it.
 */
function cancelCommitDraftSave(workspaceId: string): void {
  const existing = draftSaveTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
    draftSaveTimers.delete(workspaceId);
  }
  pendingDraftSaves.delete(workspaceId);
}

/**
 * Flush one workspace's pending draft write immediately.
 */
function flushCommitDraftSave(workspaceId: string): void {
  const existing = draftSaveTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
    draftSaveTimers.delete(workspaceId);
  }

  if (!pendingDraftSaves.has(workspaceId)) return;

  const commitDraft = pendingDraftSaves.get(workspaceId) ?? "";
  pendingDraftSaves.delete(workspaceId);
  persistPanelState(workspaceId, { commitDraft });
}

/**
 * Flush all queued draft writes, used by blur/visibilitychange and exposed
 * on the store for explicit input blur handlers.
 */
function flushAllCommitDraftSaves(): void {
  for (const workspaceId of Array.from(pendingDraftSaves.keys())) {
    flushCommitDraftSave(workspaceId);
  }
}

/**
 * Working-tree file changes do not always touch .git metadata. Treat fs.changed
 * as a passive status hint and refresh without claiming the operation spinner.
 */
function scheduleStatusHintRefresh(workspaceId: string): void {
  const existing = statusHintTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
  }

  const handle = setTimeout(() => {
    statusHintTimers.delete(workspaceId);
    void refreshStatusFromHint(workspaceId);
  }, GIT_STATUS_HINT_DEBOUNCE_MS);
  statusHintTimers.set(workspaceId, handle);
}

/**
 * Cancel a queued passive status hint when the workspace session disappears.
 */
function cancelStatusHintRefresh(workspaceId: string): void {
  const existing = statusHintTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  statusHintTimers.delete(workspaceId);
}

/**
 * Pull one status snapshot in response to an fs.changed hint. This intentionally
 * avoids beginOperation() so it cannot abort a user-initiated git operation.
 */
async function refreshStatusFromHint(workspaceId: string): Promise<void> {
  const current = useGitStore.getState().sessions.get(workspaceId);
  if (!current || current.repoInfo.kind !== "repo") return;

  try {
    const status = await ipcCall("git", "getStatus", { workspaceId });
    useGitStore.setState((state) => {
      const session = state.sessions.get(workspaceId);
      if (!session || session.repoInfo.kind !== "repo") return state;

      const next = new Map(state.sessions);
      next.set(workspaceId, {
        ...session,
        status,
        branchInfo: status.branch,
      });
      return { sessions: next };
    });
  } catch (error) {
    console.warn("[git] passive status refresh failed", error);
  }
}

/**
 * Install git broadcast listeners once per renderer module instance.
 */
function installGitEventSubscriptions(): void {
  if (!canUseIpcBridge()) return;

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
      });
      return { sessions: next };
    });
  });

  ipcListen("git", "repoInfoChanged", ({ workspaceId, info }) => {
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
  });

  ipcListen("fs", "changed", ({ workspaceId, changes }) => {
    if (changes.length === 0) return;
    const session = useGitStore.getState().sessions.get(workspaceId);
    if (!session || session.repoInfo.kind !== "repo") return;
    scheduleStatusHintRefresh(workspaceId);
  });
}

/**
 * Flush pending draft writes before the renderer loses focus or becomes
 * hidden, covering input blur and app-background paths without UI code.
 */
function installCommitDraftFlushListeners(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("blur", flushAllCommitDraftSaves);

  if (typeof document === "undefined") return;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushAllCommitDraftSaves();
    }
  });
}

/**
 * Find the first rejected `Promise.allSettled` reason in result order.
 */
function firstRejectedReason(...results: PromiseSettledResult<unknown>[]): unknown | undefined {
  for (const result of results) {
    if (result.status === "rejected") return result.reason;
  }
  return undefined;
}

/**
 * Check whether a thrown value represents an intentional abort.
 */
function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

/**
 * Normalize arbitrary thrown values into the store's user-facing error shape.
 *
 * Reads `kind` and `hint` directly off the error instance — the renderer
 * IPC client (src/renderer/ipc/client.ts) rehydrates these fields onto the
 * thrown Error from the cause envelope set by the main router, so they are
 * present here for typed Git errors. Falls back to `name` / message-based
 * inference for non-GitError throws.
 */
function gitStoreErrorFromUnknown(error: unknown, operation?: GitOperationKind): GitStoreError {
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : "Git operation failed";
    const kind =
      typeof error.kind === "string"
        ? error.kind
        : typeof error.name === "string"
          ? error.name
          : "unknown";
    const details =
      typeof error.details === "string"
        ? error.details
        : typeof error.stderr === "string"
          ? error.stderr
          : undefined;
    const hint = isGitActionHint(error.hint) ? error.hint : undefined;

    return { kind, message, details, operation, hint };
  }

  return { kind: "unknown", message: String(error), operation };
}

/**
 * Narrows a possibly-rehydrated hint payload to a GitActionHint discriminator
 * the panel consumes. The renderer IPC layer copies hint shapes verbatim, so a
 * `kind` string is the only field we need to validate before forwarding.
 */
function isGitActionHint(value: unknown): value is GitActionHint {
  if (!isRecord(value)) return false;
  return typeof value.kind === "string";
}

/**
 * Narrow unknown values to object records for safe property access.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
