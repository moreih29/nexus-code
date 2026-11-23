import { create } from "zustand";
import { isDrivePath, toSlashPath } from "../../../shared/fs/drive-path";
import { createLogger } from "../../../shared/log/renderer";
import type {
  WorkspaceConnectionChangedEvent,
  WorkspaceConnectionEventStatus,
  WorkspaceConnectionProgressEvent,
  WorkspaceMeta,
} from "../../../shared/types/workspace";
import { compareWorkspaceOrder, workspaceSortKey } from "../../../shared/workspace-order";
import { canUseIpcBridge, ipcCallResult, ipcListen, mustSucceed } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

const log = createLogger("workspaces");

export type WorkspaceConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "unstable"
  | "held-then-expired";

export interface WorkspacesState {
  workspaces: WorkspaceMeta[];
  connectionStatusByWorkspaceId: Record<string, WorkspaceConnectionStatus>;
  connectionProgressByWorkspaceId: Record<string, WorkspaceConnectionProgressEvent | undefined>;
  setAll: (workspaces: WorkspaceMeta[], snapshot?: WorkspaceConnectionChangedEvent[]) => void;
  upsert: (meta: WorkspaceMeta) => void;
  remove: (id: string) => void;
  setConnectionStatus: (id: string, status: WorkspaceConnectionStatus) => void;
  reorder: (
    orders: Array<{ id: string; sortOrder: number; pinnedSortOrder: number; pinned: boolean }>,
  ) => void;
}

interface WorkspacesStoreDeps {
  canUseIpcBridge: () => boolean;
  listen: typeof ipcListen;
  fetchList?: () => Promise<WorkspaceMeta[]>;
}

const sortKey = workspaceSortKey;
const compareSortKey = compareWorkspaceOrder;

export function applySortedInsert(
  workspaces: WorkspaceMeta[],
  meta: WorkspaceMeta,
): { workspaces: WorkspaceMeta[]; consistent: boolean } {
  const without = workspaces.filter((w) => w.id !== meta.id);
  const [mg, mo] = sortKey(meta);

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

function statusFromConnectionEvent(
  status: WorkspaceConnectionEventStatus,
): WorkspaceConnectionStatus {
  if (status === "disconnected") return "idle";
  return status as WorkspaceConnectionStatus;
}

export function selectWorkspaceConnectionStatus(
  state: WorkspacesState,
  workspaceId: string,
): WorkspaceConnectionStatus {
  return state.connectionStatusByWorkspaceId[workspaceId] ?? "idle";
}

function workspaceIsOnline(
  workspace: WorkspaceMeta | undefined,
  status: WorkspaceConnectionStatus,
): boolean {
  if (!workspace) return true;
  if (workspace.location.kind === "local") return true;
  return status === "connected" || status === "unstable" || status === "reconnecting";
}

export function selectWorkspaceConnectionProgress(
  state: WorkspacesState,
  workspaceId: string,
): WorkspaceConnectionProgressEvent | undefined {
  return state.connectionProgressByWorkspaceId[workspaceId];
}

export function selectIsWorkspaceOnline(state: WorkspacesState, workspaceId: string): boolean {
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  return workspaceIsOnline(workspace, selectWorkspaceConnectionStatus(state, workspaceId));
}

export function visibleWorkspaces(workspaces: readonly WorkspaceMeta[]): WorkspaceMeta[] {
  return workspaces.filter((workspace) => !workspace.task);
}

export function restoredWorkspace(
  workspaces: readonly WorkspaceMeta[],
  activeId: string | null,
): WorkspaceMeta | undefined {
  return (
    workspaces.find((workspace) => workspace.id === activeId) ?? visibleWorkspaces(workspaces)[0]
  );
}

export function tasksOf(workspaces: readonly WorkspaceMeta[], parentId: string): WorkspaceMeta[] {
  return workspaces.filter((workspace) => workspace.task?.parentId === parentId);
}

export function rootWorkspaceId(workspaces: readonly WorkspaceMeta[], id: string): string {
  return workspaces.find((workspace) => workspace.id === id)?.task?.parentId ?? id;
}

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

function withSlashRoot(meta: WorkspaceMeta): WorkspaceMeta {
  if (meta.location.kind !== "local" || !isDrivePath(meta.location.rootPath)) return meta;
  return {
    ...meta,
    rootPath: toSlashPath(meta.rootPath),
    location: { ...meta.location, rootPath: toSlashPath(meta.location.rootPath) },
  };
}

async function defaultFetchList(): Promise<WorkspaceMeta[]> {
  return mustSucceed(await ipcCallResult("workspace", "list", undefined));
}

const defaultWorkspacesStoreDeps: WorkspacesStoreDeps = {
  canUseIpcBridge,
  listen: ipcListen,
  fetchList: defaultFetchList,
};

export function createWorkspacesStore(deps: WorkspacesStoreDeps = defaultWorkspacesStoreDeps) {
  const fetchList = deps.fetchList ?? defaultFetchList;

  return create<WorkspacesState>((set, get) => {
    if (deps.canUseIpcBridge()) {
      deps.listen("workspace", "changed", (incoming) => {
        get().upsert(incoming);
      });

      deps.listen("workspace", "connectionChanged", ({ workspaceId, status }) => {
        set((state) => {
          const displayStatus = statusFromConnectionEvent(status);
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

      deps.listen("workspace", "reordered", ({ orders }) => {
        get().reorder(orders);
      });
    }

    registerWorkspaceCleanup((id) => get().remove(id));

    return {
      workspaces: [],
      connectionStatusByWorkspaceId: {},
      connectionProgressByWorkspaceId: {},

      setAll(incoming, snapshot = []) {
        const workspaces = incoming.map(withSlashRoot);
        set((state) => {
          const statuses = Object.fromEntries(
            snapshot.map(({ workspaceId, status }) => [
              workspaceId,
              statusFromConnectionEvent(status),
            ]),
          );
          return {
            workspaces,
            connectionStatusByWorkspaceId: pruneConnectionStatuses(
              { ...statuses, ...state.connectionStatusByWorkspaceId },
              workspaces,
            ),
          };
        });
      },

      upsert(incoming) {
        const meta = withSlashRoot(incoming);
        const { workspaces } = get();
        const existing = workspaces.find((w) => w.id === meta.id);

        if (!existing) {
          set({ workspaces: [...workspaces, meta] });
          return;
        }

        if (
          meta.sortOrder === existing.sortOrder &&
          meta.pinnedSortOrder === existing.pinnedSortOrder &&
          meta.pinned === existing.pinned
        ) {
          set({ workspaces: workspaces.map((w) => (w.id === meta.id ? meta : w)) });
          return;
        }

        const { workspaces: sorted, consistent } = applySortedInsert(workspaces, meta);
        set({ workspaces: sorted });
        if (!consistent) {
          void fetchList()
            .then((list) => {
              if (get().workspaces === sorted) get().setAll(list);
            })
            .catch((error: unknown) =>
              log.warn(`workspace order refresh failed: ${String(error)}`),
            );
        }
      },

      remove(id) {
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

export function useWorkspace(id: string | null | undefined): WorkspaceMeta | undefined;
export function useWorkspace<T>(
  id: string | null | undefined,
  pick: (workspace: WorkspaceMeta | undefined) => T,
): T;
export function useWorkspace<T>(
  id: string | null | undefined,
  pick?: (workspace: WorkspaceMeta | undefined) => T,
): T | WorkspaceMeta | undefined {
  return useWorkspacesStore((state) => {
    const workspace = id ? state.workspaces.find((w) => w.id === id) : undefined;
    return pick ? pick(workspace) : workspace;
  });
}
