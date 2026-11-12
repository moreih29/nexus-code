import { create } from "zustand";
import type { ClaudeStatus, StatusEntry } from "../../../shared/claude/status";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * ClaudeStatusStore interface.
 *
 * byWorkspace: nested record of workspaceId → tabId → StatusEntry.
 * A set that changes nothing returns the state as is, to keep selector identity stable.
 */
interface ClaudeStatusStore {
  byWorkspace: Record<string, Record<string, StatusEntry>>;
  /**
   * Replaces all of byWorkspace with the snapshot API response.
   * Workspace entries missing from the new snapshot are removed.
   */
  setMany(entries: StatusEntry[]): void;
  /**
   * Updates a single (workspaceId, tabId) entry.
   * Identical status, message and since values leave the state unchanged, keeping identity.
   */
  set(entry: StatusEntry): void;
  /**
   * Removes a specific (workspaceId, tabId) entry.
   */
  clearTab(workspaceId: string, tabId: string): void;
  /**
   * Removes every tab entry of a workspace.
   */
  clearWorkspace(workspaceId: string): void;
}

// ---------------------------------------------------------------------------
// Stable fallback constants for selectors (fixed at module level — avoids new references per render)
// ---------------------------------------------------------------------------

/** Stable reference for an empty tab record. Selectors return it instead of undefined. */
export const EMPTY_TABS: Record<string, StatusEntry> = {};

// ---------------------------------------------------------------------------
// Priority ordering helpers
// ---------------------------------------------------------------------------

/**
 * Statuses that need attention. Shared by isAttentionRequired and the aggregate selector.
 *
 * Note: completed is deliberately excluded. completed ("response finished") only shows
 * as a tab indicator, and the OS notification is fired separately in hook-handler. The
 * sidebar workspace aggregate must catch only real attention that needs user input
 * (needsInput/permissionPending/error); otherwise ClaudeWorkspaceIndicator would render
 * completed with the needsInput glyph, which is inaccurate.
 */
export const ATTENTION_STATUSES: readonly ClaudeStatus[] = [
  "needsInput",
  "permissionPending",
  "error",
];

/**
 * Statuses to show as a glyph on the workspace card. All 6 statuses are included.
 *
 * Why idle is included: a workspace where the user has started a session at least once
 * (a StatusEntry exists) shows as a "dim, acknowledged state (gray check)". A workspace
 * with no StatusEntry has undefined wsTabs, so the caller (WorkspaceRow) renders no glyph.
 *
 * Unlike ATTENTION_STATUSES, which carries the semantics of "needs user input",
 * WORKSPACE_VISIBLE_STATUSES is the display policy for "which statuses get a card glyph".
 */
export const WORKSPACE_VISIBLE_STATUSES: readonly ClaudeStatus[] = [
  "idle",
  "running",
  "completed",
  "needsInput",
  "permissionPending",
  "error",
];

/**
 * Status priority mapping.
 * permissionPending(5) > error(4) > needsInput(3) > completed(2) > running(1) > idle(0)
 *
 * completed sits above running and below needsInput: a weak attention that signals the response ended.
 */
export const STATUS_PRIORITY: Record<ClaudeStatus, number> = {
  idle: 0,
  running: 1,
  completed: 2,
  needsInput: 3,
  error: 4,
  permissionPending: 5,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Renderer-wide Claude session status store.
 *
 * Initialized from a snapshot at bootstrap, then updated incrementally by status events.
 * workspaceId keys are cleaned up automatically through the workspace-cleanup registry.
 */
export const useClaudeStatusStore = create<ClaudeStatusStore>((set, get) => {
  // On workspace removal, clear all entries of that workspaceId.
  registerWorkspaceCleanup((workspaceId) => {
    get().clearWorkspace(workspaceId);
  });

  return {
    byWorkspace: {},

    setMany(entries) {
      // Convert entries into a nested workspaceId → tabId → entry record.
      const next: Record<string, Record<string, StatusEntry>> = {};
      for (const entry of entries) {
        if (!next[entry.workspaceId]) {
          next[entry.workspaceId] = {};
        }
        next[entry.workspaceId][entry.tabId] = entry;
      }
      set({ byWorkspace: next });
    },

    set(entry) {
      set((state) => {
        const wsRecord = state.byWorkspace[entry.workspaceId];
        const existing = wsRecord?.[entry.tabId];

        // Identical value preserves state identity (prevents useSyncExternalStore thrashing).
        if (
          existing !== undefined &&
          existing.status === entry.status &&
          existing.message === entry.message &&
          existing.since === entry.since &&
          existing.prompt === entry.prompt
        ) {
          return state;
        }

        return {
          byWorkspace: {
            ...state.byWorkspace,
            [entry.workspaceId]: {
              ...(wsRecord ?? {}),
              [entry.tabId]: entry,
            },
          },
        };
      });
    },

    clearTab(workspaceId, tabId) {
      set((state) => {
        const wsRecord = state.byWorkspace[workspaceId];
        if (!wsRecord || !(tabId in wsRecord)) return state;
        const next = { ...wsRecord };
        delete next[tabId];
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: next,
          },
        };
      });
    },

    clearWorkspace(workspaceId) {
      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const next = { ...state.byWorkspace };
        delete next[workspaceId];
        return { byWorkspace: next };
      });
    },
  };
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Returns the StatusEntry of a specific (workspaceId, tabId).
 * Returns undefined if it does not exist.
 */
export function selectStatusForTab(
  state: ClaudeStatusStore,
  workspaceId: string,
  tabId: string,
): StatusEntry | undefined {
  return state.byWorkspace[workspaceId]?.[tabId];
}

/**
 * Aggregates all tab statuses in a workspace and returns the highest-priority status
 * and the number of tabs needing attention.
 *
 * Priority: permissionPending(4) > error(3) > needsInput(2) > running(1) > idle/none(0)
 * count is the number of tabs needing attention (needsInput | permissionPending | error).
 * Returns null if there is no active tab.
 *
 * Note: callers must memoize the result with a shallow comparison to keep identity across renders.
 */
export function selectWorkspaceAggregateStatus(
  state: ClaudeStatusStore,
  workspaceId: string,
): { status: ClaudeStatus; count: number } | null {
  const wsRecord = state.byWorkspace[workspaceId];
  if (!wsRecord) return null;

  const entries = Object.values(wsRecord);
  if (entries.length === 0) return null;

  let topPriority = -1;
  let topStatus: ClaudeStatus = "idle";
  let attentionCount = 0;

  for (const entry of entries) {
    const priority = STATUS_PRIORITY[entry.status];
    if (priority > topPriority) {
      topPriority = priority;
      topStatus = entry.status;
    }
    if (ATTENTION_STATUSES.includes(entry.status)) {
      attentionCount++;
    }
  }

  // Return a result even when every tab is idle and there is no attention.
  return { status: topStatus, count: attentionCount };
}

/**
 * Returns whether a workspace has at least one tab needing attention.
 * (true when a needsInput | permissionPending | error tab exists)
 */
export function selectIsWorkspaceAttention(state: ClaudeStatusStore, workspaceId: string): boolean {
  const aggregate = selectWorkspaceAggregateStatus(state, workspaceId);
  return aggregate !== null && ATTENTION_STATUSES.includes(aggregate.status);
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Returns whether the given status needs user attention.
 * True for needsInput | permissionPending | error.
 */
export function isAttentionRequired(status: ClaudeStatus | undefined): boolean {
  return status !== undefined && ATTENTION_STATUSES.includes(status);
}
