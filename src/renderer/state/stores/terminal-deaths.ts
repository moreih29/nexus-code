import { create } from "zustand";
import { defaultTimerScheduler, type TimerScheduler } from "../../../shared/util/timer-scheduler";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

export const TERMINAL_DEATH_AGGREGATE_WINDOW_MS = 100;

export interface TerminalDeathAggregate {
  tabIds: string[];
}

interface PendingDeathWindow {
  tabIds: Set<string>;
  timerHandle: unknown;
  getDeadTerminalIds: () => Set<string>;
}

interface TerminalDeathState {
  aggregateByWorkspaceId: Record<string, TerminalDeathAggregate>;
  publishAggregate: (
    workspaceId: string,
    tabIds: string[],
    currentDeadTerminalIds: Set<string>,
  ) => void;
  removeTerminal: (workspaceId: string, tabId: string, currentDeadTerminalIds: Set<string>) => void;
  clearWorkspace: (workspaceId: string) => void;
  reset: () => void;
}

let scheduler: TimerScheduler = defaultTimerScheduler;
const pendingDeathWindows = new Map<string, PendingDeathWindow>();

/**
 * Clears an open aggregate window without publishing a workspace banner.
 */
function clearPendingDeathWindow(workspaceId: string): void {
  const pending = pendingDeathWindows.get(workspaceId);
  if (!pending) return;
  scheduler.clearTimeout(pending.timerHandle);
  pendingDeathWindows.delete(workspaceId);
}

/**
 * Commits a workspace's bounded death window if two or more recorded tabs
 * are still dead when the window closes.
 */
function flushDeathWindow(workspaceId: string): void {
  const pending = pendingDeathWindows.get(workspaceId);
  if (!pending) return;
  pendingDeathWindows.delete(workspaceId);

  const currentDeadTerminalIds = pending.getDeadTerminalIds();
  const tabIds = [...pending.tabIds].filter((tabId) => currentDeadTerminalIds.has(tabId));
  if (tabIds.length < 2) return;

  useTerminalDeathStore.getState().publishAggregate(workspaceId, tabIds, currentDeadTerminalIds);
}

/**
 * Narrows an aggregate to tabs that remain dead, clearing the banner once it
 * no longer represents a multi-terminal disconnect.
 */
function aggregateWithCurrentDeadTabs(
  tabIds: Iterable<string>,
  currentDeadTerminalIds: Set<string>,
): TerminalDeathAggregate | null {
  const nextTabIds = [...new Set(tabIds)].filter((tabId) => currentDeadTerminalIds.has(tabId));
  if (nextTabIds.length < 2) return null;
  return { tabIds: nextTabIds };
}

/**
 * Stores workspace-level dead-terminal aggregate banners. The per-tab dead
 * flag stays in `tabs.ts`; this store only tracks whether recent deaths were
 * close enough together to deserve a workspace banner.
 */
export const useTerminalDeathStore = createTerminalDeathStore();

/**
 * Builds the production terminal death store.
 */
function createTerminalDeathStore() {
  return create<TerminalDeathState>((set) => {
    registerWorkspaceCleanup((workspaceId) => {
      clearPendingDeathWindow(workspaceId);
      set((state) => {
        if (!(workspaceId in state.aggregateByWorkspaceId)) return state;
        const next = { ...state.aggregateByWorkspaceId };
        delete next[workspaceId];
        return { aggregateByWorkspaceId: next };
      });
    });

    return {
      aggregateByWorkspaceId: {},

      publishAggregate(workspaceId, tabIds, currentDeadTerminalIds) {
        set((state) => {
          const existing = state.aggregateByWorkspaceId[workspaceId]?.tabIds ?? [];
          const aggregate = aggregateWithCurrentDeadTabs(
            [...existing, ...tabIds],
            currentDeadTerminalIds,
          );
          const next = { ...state.aggregateByWorkspaceId };
          if (aggregate) {
            next[workspaceId] = aggregate;
          } else {
            delete next[workspaceId];
          }
          return { aggregateByWorkspaceId: next };
        });
      },

      removeTerminal(workspaceId, tabId, currentDeadTerminalIds) {
        set((state) => {
          const existing = state.aggregateByWorkspaceId[workspaceId];
          if (!existing) return state;
          const aggregate = aggregateWithCurrentDeadTabs(
            existing.tabIds.filter((id) => id !== tabId),
            currentDeadTerminalIds,
          );
          const next = { ...state.aggregateByWorkspaceId };
          if (aggregate) {
            next[workspaceId] = aggregate;
          } else {
            delete next[workspaceId];
          }
          return { aggregateByWorkspaceId: next };
        });
      },

      clearWorkspace(workspaceId) {
        clearPendingDeathWindow(workspaceId);
        set((state) => {
          if (!(workspaceId in state.aggregateByWorkspaceId)) return state;
          const next = { ...state.aggregateByWorkspaceId };
          delete next[workspaceId];
          return { aggregateByWorkspaceId: next };
        });
      },

      reset() {
        for (const workspaceId of pendingDeathWindows.keys()) {
          clearPendingDeathWindow(workspaceId);
        }
        set({ aggregateByWorkspaceId: {} });
      },
    };
  });
}

/**
 * Starts a new 100ms aggregate window if none is pending; otherwise appends
 * to the open window without resetting its timer.
 */
export function recordTerminalDeathForAggregate(
  workspaceId: string,
  tabId: string,
  getDeadTerminalIds: () => Set<string>,
): void {
  const existing = pendingDeathWindows.get(workspaceId);
  if (existing) {
    existing.tabIds.add(tabId);
    existing.getDeadTerminalIds = getDeadTerminalIds;
    return;
  }

  const pending: PendingDeathWindow = {
    tabIds: new Set([tabId]),
    timerHandle: scheduler.setTimeout(
      () => flushDeathWindow(workspaceId),
      TERMINAL_DEATH_AGGREGATE_WINDOW_MS,
    ),
    getDeadTerminalIds,
  };
  pendingDeathWindows.set(workspaceId, pending);
}

/**
 * Removes one terminal from pending and published aggregate state.
 */
export function releaseTerminalDeathFromAggregate(
  workspaceId: string,
  tabId: string,
  currentDeadTerminalIds: Set<string>,
): void {
  const pending = pendingDeathWindows.get(workspaceId);
  if (pending) {
    pending.tabIds.delete(tabId);
    if (pending.tabIds.size === 0) {
      clearPendingDeathWindow(workspaceId);
    }
  }
  useTerminalDeathStore.getState().removeTerminal(workspaceId, tabId, currentDeadTerminalIds);
}

/**
 * Replaces the scheduler that owns aggregate windows. Returns a cleanup
 * callback that restores the browser scheduler and clears pending windows.
 */
export function configureTerminalDeathAggregationScheduler(
  nextScheduler: TimerScheduler,
): () => void {
  for (const workspaceId of pendingDeathWindows.keys()) {
    clearPendingDeathWindow(workspaceId);
  }
  scheduler = nextScheduler;
  return () => {
    for (const workspaceId of pendingDeathWindows.keys()) {
      clearPendingDeathWindow(workspaceId);
    }
    scheduler = defaultTimerScheduler;
  };
}
