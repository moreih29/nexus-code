import { create } from "zustand";
import type {
  WorkspaceConnectionEventStatus,
  WorkspaceConnectionProgressEvent,
  WorkspaceMeta,
} from "../../../shared/types/workspace";
import { canUseIpcBridge, ipcCallResult, ipcListen, mustSucceed } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type WorkspaceConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  /**
   * Transient: 1 missed heartbeat. workspaceIsOnline stays true.
   * Renderer shows the "unstable" dot badge on the sidebar workspace entry.
   */
  | "unstable"
  /**
   * Terminal: daemon replaced during reconnect window. Held PTY sessions are
   * gone. Renderer shows "session expired" empty state instead of the generic
   * connection error. workspaceIsOnline=false so the user must reconnect.
   */
  | "held-then-expired";

export interface WorkspacesState {
  workspaces: WorkspaceMeta[];
  connectionStatusByWorkspaceId: Record<string, WorkspaceConnectionStatus>;
  /** 워크스페이스 ID별 마지막 부트스트랩 진행 이벤트. 연결 완료/오류 시 undefined로 클리어된다. */
  connectionProgressByWorkspaceId: Record<string, WorkspaceConnectionProgressEvent | undefined>;
  setAll: (workspaces: WorkspaceMeta[]) => void;
  upsert: (meta: WorkspaceMeta) => void;
  remove: (id: string) => void;
  setConnectionStatus: (id: string, status: WorkspaceConnectionStatus) => void;
  /** Bulk-update sort positions after a server-side group rebalance. */
  reorder: (orders: Array<{ id: string; sortOrder: number; pinnedSortOrder: number; pinned: boolean }>) => void;
}

interface WorkspacesStoreDeps {
  canUseIpcBridge: () => boolean;
  listen: typeof ipcListen;
  /** Injected so tests can verify fallback behaviour without real IPC. */
  fetchList?: () => Promise<WorkspaceMeta[]>;
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

/**
 * Returns the effective sort key for a workspace within the unified list.
 * Primary sort: pinned rows float above unpinned rows (pinned=true → 0, false → 1).
 * Secondary sort: the group-specific order column (ascending).
 */
function sortKey(meta: WorkspaceMeta): [number, number] {
  const groupOrdinal = meta.pinned ? 0 : 1;
  const orderWithinGroup = meta.pinned ? meta.pinnedSortOrder : meta.sortOrder;
  return [groupOrdinal, orderWithinGroup ?? 0];
}

/**
 * Compares two workspaces using their (pinned DESC, groupOrder ASC) sort keys.
 */
function compareSortKey(a: WorkspaceMeta, b: WorkspaceMeta): number {
  const [ag, ao] = sortKey(a);
  const [bg, bo] = sortKey(b);
  if (ag !== bg) return ag - bg;
  return ao - bo;
}

/**
 * Inserts `meta` into the correct sorted position within `workspaces`.
 *
 * The list is ordered by: pinned DESC, then the group-specific order column ASC.
 * The function removes any existing entry for `meta.id` first, then finds the
 * insertion index via binary search on the effective sort key, and inserts.
 *
 * Returns the new array and a `consistent` flag.  `consistent` is false when
 * the inserted item's sort key conflicts with its immediate neighbours — which
 * signals that the local store is stale and a full list re-fetch is needed.
 */
export function applySortedInsert(
  workspaces: WorkspaceMeta[],
  meta: WorkspaceMeta,
): { workspaces: WorkspaceMeta[]; consistent: boolean } {
  // Remove the old entry for this id so we re-insert at the correct position.
  const without = workspaces.filter((w) => w.id !== meta.id);
  const [mg, mo] = sortKey(meta);

  // Binary search for the insertion point.
  let lo = 0;
  let hi = without.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const [wg, wo] = sortKey(without[mid]);
    if (wg < mg || (wg === mg && wo <= mo)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const insertIdx = lo;

  const result = [...without.slice(0, insertIdx), meta, ...without.slice(insertIdx)];

  // Consistency check: the item's sort key must sit strictly between its neighbours.
  // A tie (equal sort key) is also inconsistent — two items cannot legitimately
  // share the same position without a prior rebalance broadcast being missed.
  const prev = result[insertIdx - 1];
  const next = result[insertIdx + 1];
  let consistent = true;
  if (prev) {
    const [pg, po] = sortKey(prev);
    if (pg > mg || (pg === mg && po >= mo)) {
      consistent = false;
    }
  }
  if (next) {
    const [ng, no] = sortKey(next);
    if (ng < mg || (ng === mg && no <= mo)) {
      consistent = false;
    }
  }

  return { workspaces: result, consistent };
}

/**
 * Converts transport lifecycle statuses into compact sidebar display statuses.
 */
function statusFromConnectionEvent(
  status: WorkspaceConnectionEventStatus,
): WorkspaceConnectionStatus {
  if (status === "disconnected") return "idle";
  // Pass new statuses through directly; the renderer store type was extended
  // to include them. Legacy / unknown statuses fall back to "idle".
  return status as WorkspaceConnectionStatus;
}

/**
 * Returns the sidebar/workspace display status for a workspace id.
 */
export function selectWorkspaceConnectionStatus(
  state: WorkspacesState,
  workspaceId: string,
): WorkspaceConnectionStatus {
  return state.connectionStatusByWorkspaceId[workspaceId] ?? "idle";
}

/**
 * Treats the workspace connection store as the single source of truth for
 * renderer affordances that need to know whether a workspace is online.
 *
 * "unstable" (1 missed heartbeat) is treated as online — the channel is still
 * alive and the workspace is usable; only the indicator dot changes.
 * "reconnecting" is also treated as online because PTY sessions are on hold
 * (not dead) and the workspace may recover.
 * "held-then-expired" is offline — the daemon was replaced and the user must
 * explicitly reconnect.
 */
function workspaceIsOnline(
  workspace: WorkspaceMeta | undefined,
  status: WorkspaceConnectionStatus,
): boolean {
  if (!workspace) return true;
  if (workspace.location.kind === "local") return true;
  return status === "connected" || status === "unstable" || status === "reconnecting";
}

/**
 * 워크스페이스의 마지막 부트스트랩 진행 이벤트를 반환한다.
 * 연결이 terminal 상태에 도달하면 undefined를 반환한다.
 */
export function selectWorkspaceConnectionProgress(
  state: WorkspacesState,
  workspaceId: string,
): WorkspaceConnectionProgressEvent | undefined {
  return state.connectionProgressByWorkspaceId[workspaceId];
}

/**
 * Selects whether a workspace should expose online-only per-tab status UI.
 */
export function selectIsWorkspaceOnline(state: WorkspacesState, workspaceId: string): boolean {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  return workspaceIsOnline(workspace, selectWorkspaceConnectionStatus(state, workspaceId));
}

/**
 * Removes connection state for workspaces that no longer exist in the list.
 */
function pruneConnectionStatuses(
  current: Record<string, WorkspaceConnectionStatus>,
  workspaces: WorkspaceMeta[],
): Record<string, WorkspaceConnectionStatus> {
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  const next: Record<string, WorkspaceConnectionStatus> = {};
  for (const [id, status] of Object.entries(current)) {
    if (ids.has(id)) {
      next[id] = status;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Fetches the current workspace list from the main process and returns it.
 * Used as the fallback when a sort-position inconsistency is detected after a
 * `workspace.changed` event arrives with an unexpected order.
 */
async function defaultFetchList(): Promise<WorkspaceMeta[]> {
  return mustSucceed(await ipcCallResult("workspace", "list", undefined));
}

const defaultWorkspacesStoreDeps: WorkspacesStoreDeps = {
  canUseIpcBridge,
  listen: ipcListen,
  fetchList: defaultFetchList,
};

/**
 * Creates the workspace store with injectable IPC dependencies for tests.
 */
export function createWorkspacesStore(deps: WorkspacesStoreDeps = defaultWorkspacesStoreDeps) {
  // Resolve the fallback fetch function once at store creation time so the
  // closure captures the injected value (important for tests).
  const fetchList = deps.fetchList ?? defaultFetchList;

  return create<WorkspacesState>((set, get) => {
    // Subscribe to main-process changed events so store stays in sync.
    // `removed` is handled by the central workspace-cleanup registry; only
    // `changed` and `reordered` need inline ipcListen here.
    if (deps.canUseIpcBridge()) {
      deps.listen("workspace", "changed", (meta) => {
        set((state) => {
          const existing = state.workspaces.find((w) => w.id === meta.id);

          if (!existing) {
            // New workspace — append at tail; setAll will reorder on next full load.
            return { workspaces: [...state.workspaces, meta] };
          }

          // Hot-path guard: if only non-sort fields changed (e.g. lastOpenedAt),
          // update in place without triggering a re-sort.
          const sortFieldsChanged =
            meta.sortOrder !== existing.sortOrder ||
            meta.pinnedSortOrder !== existing.pinnedSortOrder ||
            meta.pinned !== existing.pinned;

          if (!sortFieldsChanged) {
            const next = state.workspaces.map((w) => (w.id === meta.id ? meta : w));
            return { workspaces: next };
          }

          // Sort position changed — re-insert at the correct position.
          const { workspaces: sorted, consistent } = applySortedInsert(state.workspaces, meta);

          if (!consistent) {
            // Store is stale; trigger an async full re-fetch outside the setter.
            void fetchList().then((list) => {
              get().setAll(list);
            });
          }

          return { workspaces: sorted };
        });
      });

      deps.listen("workspace", "connectionChanged", ({ workspaceId, status }) => {
        set((state) => {
          const displayStatus = statusFromConnectionEvent(status);
          // 연결이 terminal 상태(connected/error/idle/disconnected)에 도달하면
          // 진행 표시줄이 남아있지 않도록 progress 항목을 클리어한다.
          const isTerminal = displayStatus !== "connecting" && displayStatus !== "reconnecting";
          const nextProgress = isTerminal
            ? { ...state.connectionProgressByWorkspaceId, [workspaceId]: undefined }
            : state.connectionProgressByWorkspaceId;
          return {
            connectionStatusByWorkspaceId: {
              ...state.connectionStatusByWorkspaceId,
              [workspaceId]: displayStatus,
            },
            connectionProgressByWorkspaceId: nextProgress,
          };
        });
      });

      deps.listen("workspace", "connectionProgress", (event) => {
        set((state) => ({
          connectionProgressByWorkspaceId: {
            ...state.connectionProgressByWorkspaceId,
            [event.workspaceId]: event,
          },
        }));
      });

      // Bulk rebalance event: main sends new positions for every affected row.
      deps.listen("workspace", "reordered", ({ orders }) => {
        get().reorder(orders);
      });
    }

    registerWorkspaceCleanup((id) => {
      set((state) => ({
        workspaces: state.workspaces.filter((w) => w.id !== id),
        connectionStatusByWorkspaceId: Object.fromEntries(
          Object.entries(state.connectionStatusByWorkspaceId).filter(
            ([workspaceId]) => workspaceId !== id,
          ),
        ),
        connectionProgressByWorkspaceId: Object.fromEntries(
          Object.entries(state.connectionProgressByWorkspaceId).filter(
            ([workspaceId]) => workspaceId !== id,
          ),
        ),
      }));
    });

    return {
      workspaces: [],
      connectionStatusByWorkspaceId: {},
      connectionProgressByWorkspaceId: {},

      setAll(workspaces) {
        set((state) => ({
          workspaces,
          connectionStatusByWorkspaceId: pruneConnectionStatuses(
            state.connectionStatusByWorkspaceId,
            workspaces,
          ),
        }));
      },

      upsert(meta) {
        set((state) => {
          const existing = state.workspaces.find((w) => w.id === meta.id);

          if (!existing) {
            // New workspace — append at tail; sort will be applied on next setAll.
            return { workspaces: [...state.workspaces, meta] };
          }

          // Hot-path guard: if sort fields are unchanged, update in place.
          const sortFieldsChanged =
            meta.sortOrder !== existing.sortOrder ||
            meta.pinnedSortOrder !== existing.pinnedSortOrder ||
            meta.pinned !== existing.pinned;

          if (!sortFieldsChanged) {
            const next = state.workspaces.map((w) => (w.id === meta.id ? meta : w));
            return { workspaces: next };
          }

          // Sort position changed — re-insert at the correct position.
          const { workspaces: sorted, consistent } = applySortedInsert(state.workspaces, meta);

          if (!consistent) {
            void fetchList().then((list) => {
              get().setAll(list);
            });
          }

          return { workspaces: sorted };
        });
      },

      remove(id) {
        set((state) => ({
          workspaces: state.workspaces.filter((w) => w.id !== id),
          connectionStatusByWorkspaceId: Object.fromEntries(
            Object.entries(state.connectionStatusByWorkspaceId).filter(
              ([workspaceId]) => workspaceId !== id,
            ),
          ),
        }));
      },

      setConnectionStatus(id, status) {
        set((state) => ({
          connectionStatusByWorkspaceId: {
            ...state.connectionStatusByWorkspaceId,
            [id]: status,
          },
        }));
      },

      reorder(orders) {
        set((state) => {
          // Patch each row's sort fields, then re-sort the full array.
          const patched = state.workspaces.map((w) => {
            const update = orders.find((o) => o.id === w.id);
            if (!update) return w;
            return {
              ...w,
              sortOrder: update.sortOrder,
              pinnedSortOrder: update.pinnedSortOrder,
              pinned: update.pinned,
            };
          });
          return { workspaces: patched.sort(compareSortKey) };
        });
      },
    };
  });
}

export const useWorkspacesStore = createWorkspacesStore();
