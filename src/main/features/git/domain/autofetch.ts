/**
 * Workspace-scoped Git autofetch scheduler.
 *
 * A single master timer wakes once per second and checks each open workspace's
 * persisted Source Control panel state. Due work is enqueued through the
 * repository queue, but background runs deliberately use non-interactive Git
 * so credential prompts are never shown unless the user explicitly clicks a
 * fetch action.
 */
import type {
  GitAutofetchError,
  GitAutofetchIntervalMin,
  GitAutofetchStateChanged,
  GitFetchAllResult,
} from "../../../../shared/git/types";
import { normalizeGitAutofetchIntervalMin } from "../../../../shared/git/types";
import type { WorkspaceStorage } from "../../../infra/storage/workspace-storage";
import { isSshWorkspace } from "../../workspace/guards";
import type { BroadcastFn, WorkspaceManager } from "../../workspace/manager";
import { GitError } from "./error";
import type { GitRegistry } from "./registry";

const AUTOFETCH_TICK_MS = 1_000;
const FAILURE_PAUSE_THRESHOLD = 3;

interface AutofetchWorkspaceState {
  nextFetchAt: number | null;
  fetching: boolean;
  consecutiveFailures: number;
  lastError: GitAutofetchError | null;
  pausedBannerShown: boolean;
}

export interface GitAutofetchSchedulerOptions {
  readonly registry: GitRegistry;
  readonly storage: WorkspaceStorage;
  readonly workspaceManager: WorkspaceManager;
  readonly broadcast: BroadcastFn;
  readonly tickMs?: number;
  readonly now?: () => number;
}

/**
 * Coordinates background `git fetch --all --prune` across all open workspaces.
 */
export class GitAutofetchScheduler {
  private readonly registry: GitRegistry;
  private readonly storage: WorkspaceStorage;
  private readonly workspaceManager: WorkspaceManager;
  private readonly broadcast: BroadcastFn;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, AutofetchWorkspaceState>();
  private timer: NodeJS.Timeout | null = null;
  private globalPaused = false;

  constructor(options: GitAutofetchSchedulerOptions) {
    this.registry = options.registry;
    this.storage = options.storage;
    this.workspaceManager = options.workspaceManager;
    this.broadcast = options.broadcast;
    this.tickMs = options.tickMs ?? AUTOFETCH_TICK_MS;
    this.now = options.now ?? Date.now;
  }

  /** Starts the one-second master timer. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
  }

  /** Stops the master timer and forgets in-memory failure/schedule state. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.states.clear();
  }

  /** Drops scheduler state for a workspace that was removed. */
  disposeWorkspace(workspaceId: string): void {
    this.states.delete(workspaceId);
  }

  /**
   * Pauses/resumes background due checks globally. Focus resume recalculates
   * next due times from "now" so missed due times are not replayed immediately.
   */
  setGlobalPaused(paused: boolean): void {
    if (this.globalPaused === paused) return;
    this.globalPaused = paused;
    if (!paused) this.recalculateDueTimes();
  }

  /** Persists and applies one workspace's autofetch cadence. */
  setSchedule(workspaceId: string, intervalMin: GitAutofetchIntervalMin): void {
    const normalizedIntervalMin = normalizeGitAutofetchIntervalMin(intervalMin);
    if (normalizedIntervalMin === 0) {
      this.storage.setGitPanelState(workspaceId, {
        autofetchIntervalMin: normalizedIntervalMin,
        autofetchManualPaused: false,
      });
      const state = this.stateFor(workspaceId);
      state.nextFetchAt = null;
      state.consecutiveFailures = 0;
      state.lastError = null;
      state.pausedBannerShown = false;
      this.broadcastState(workspaceId, false);
      return;
    }

    this.storage.setGitPanelState(workspaceId, {
      autofetchIntervalMin: normalizedIntervalMin,
      autofetchManualPaused: false,
    });
    const state = this.stateFor(workspaceId);
    state.nextFetchAt = this.now() + intervalToMs(normalizedIntervalMin);
    state.consecutiveFailures = 0;
    state.lastError = null;
    state.pausedBannerShown = false;
    this.broadcastState(workspaceId, false);
  }

  /** Persists a user-requested pause without changing the interval. */
  pause(workspaceId: string): void {
    this.storage.setGitPanelState(workspaceId, { autofetchManualPaused: true });
    const state = this.stateFor(workspaceId);
    state.nextFetchAt = null;
    this.broadcastState(workspaceId, false);
  }

  /** Clears pause/failure state and schedules the next due check from now. */
  resume(workspaceId: string): void {
    const panelState = this.storage.getGitPanelState(workspaceId);
    this.storage.setGitPanelState(workspaceId, { autofetchManualPaused: false });
    const state = this.stateFor(workspaceId);
    state.consecutiveFailures = 0;
    state.lastError = null;
    state.pausedBannerShown = false;
    state.nextFetchAt =
      panelState.autofetchIntervalMin === 0
        ? null
        : this.now() + intervalToMs(panelState.autofetchIntervalMin);
    this.broadcastState(workspaceId, false);
  }

  /**
   * Runs an explicit fetch-all. User-triggered calls use helpers and clear any
   * sticky auth/network state on success; failures update the chip but do not
   * contribute to the background three-strikes pause threshold.
   */
  async fetchNow(workspaceId: string, signal?: AbortSignal): Promise<GitFetchAllResult> {
    return this.runFetch(workspaceId, { interactive: true, countFailureForPause: false, signal });
  }

  /**
   * Performs one due scan. Exposed for deterministic unit tests; production
   * calls it from the master timer.
   */
  async tick(): Promise<void> {
    if (this.globalPaused) return;

    const due: Promise<GitFetchAllResult>[] = [];
    const now = this.now();
    for (const workspace of this.workspaceManager.list()) {
      if (isSshWorkspace(workspace)) continue;
      if (!this.storage.isOpen(workspace.id)) continue;
      const panelState = this.storage.getGitPanelState(workspace.id);
      if (panelState.autofetchIntervalMin === 0 || panelState.autofetchManualPaused) continue;

      const state = this.stateFor(workspace.id);
      if (state.fetching) continue;
      if (state.nextFetchAt === null) {
        state.nextFetchAt = now + intervalToMs(panelState.autofetchIntervalMin);
        continue;
      }
      if (now < state.nextFetchAt) continue;

      state.nextFetchAt = now + intervalToMs(panelState.autofetchIntervalMin);
      due.push(
        this.runFetch(workspace.id, {
          interactive: false,
          countFailureForPause: true,
        }).catch(() => ({ fetched: false, lastFetchedAt: null })),
      );
    }
    await Promise.all(due);
  }

  /** Recomputes next due times for all open, scheduled workspaces. */
  private recalculateDueTimes(): void {
    const now = this.now();
    for (const workspace of this.workspaceManager.list()) {
      if (!this.storage.isOpen(workspace.id)) continue;
      const panelState = this.storage.getGitPanelState(workspace.id);
      const state = this.stateFor(workspace.id);
      state.nextFetchAt =
        panelState.autofetchIntervalMin === 0 || panelState.autofetchManualPaused
          ? null
          : now + intervalToMs(panelState.autofetchIntervalMin);
    }
  }

  /** Fetches a repository, records failure policy, and broadcasts status once. */
  private async runFetch(
    workspaceId: string,
    options: {
      readonly interactive: boolean;
      readonly countFailureForPause: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<GitFetchAllResult> {
    const state = this.stateFor(workspaceId);
    if (state.fetching) return { fetched: false, lastFetchedAt: null };

    state.fetching = true;
    this.broadcastState(workspaceId, false);

    try {
      const repo = await this.registry.getOrDetect(workspaceId, options.signal);
      if (!repo) throw new GitError("not-repo", "Not a Git repository");

      await repo.fetchAll({ interactive: options.interactive }, options.signal);
      this.registry.bumpGeneration(workspaceId);
      const status = await this.registry.refreshStatus(workspaceId, options.signal);

      this.storage.setGitPanelState(workspaceId, { autofetchManualPaused: false });
      state.consecutiveFailures = 0;
      state.lastError = null;
      state.pausedBannerShown = false;
      state.fetching = false;
      this.broadcastState(workspaceId, false);
      return { fetched: true, lastFetchedAt: status.lastFetchedAt };
    } catch (error) {
      state.fetching = false;
      const sticky = isAuthFailure(error);
      state.lastError = {
        kind: errorKind(error),
        message: errorMessage(error),
        sticky,
      };

      let showPausedBanner = false;
      if (options.countFailureForPause) {
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= FAILURE_PAUSE_THRESHOLD) {
          this.storage.setGitPanelState(workspaceId, { autofetchManualPaused: true });
          state.nextFetchAt = null;
          showPausedBanner = !state.pausedBannerShown;
          state.pausedBannerShown = true;
        }
      }

      this.broadcastState(workspaceId, showPausedBanner);
      throw error;
    }
  }

  /** Returns mutable in-memory state for a workspace. */
  private stateFor(workspaceId: string): AutofetchWorkspaceState {
    let state = this.states.get(workspaceId);
    if (!state) {
      state = {
        nextFetchAt: null,
        fetching: false,
        consecutiveFailures: 0,
        lastError: null,
        pausedBannerShown: false,
      };
      this.states.set(workspaceId, state);
    }
    return state;
  }

  /** Emits the renderer-facing autofetch state snapshot. */
  private broadcastState(workspaceId: string, showPausedBanner: boolean): void {
    const state = this.stateFor(workspaceId);
    const panelState = this.storage.getGitPanelState(workspaceId);
    const payload: GitAutofetchStateChanged = {
      workspaceId,
      fetching: state.fetching,
      paused: panelState.autofetchManualPaused,
      consecutiveFailures: state.consecutiveFailures,
      lastError: state.lastError,
      showPausedBanner,
    };
    this.broadcast("autofetch", "stateChanged", payload);
  }
}

/** Converts a supported persisted interval to milliseconds. */
export function intervalToMs(intervalMin: GitAutofetchIntervalMin): number {
  return intervalMin * 60_000;
}

/** True when a failed fetch should remain sticky until explicit success/resume. */
function isAuthFailure(error: unknown): boolean {
  return error instanceof GitError && (error.kind === "auth" || error.kind === "auth-required");
}

/** Extracts a compact failure kind for renderer chip state. */
function errorKind(error: unknown): string {
  if (error instanceof GitError) return error.kind;
  if (error instanceof Error) return error.name || "unknown";
  return "unknown";
}

/** Extracts a user-facing failure message without throwing during serialization. */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Fetch failed";
}
