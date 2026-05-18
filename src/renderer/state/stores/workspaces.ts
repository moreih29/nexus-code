import { create } from "zustand";
import type {
  WorkspaceConnectionEventStatus,
  WorkspaceMeta,
} from "../../../shared/types/workspace";
import { canUseIpcBridge, ipcListen } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type WorkspaceConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface WorkspacesState {
  workspaces: WorkspaceMeta[];
  connectionStatusByWorkspaceId: Record<string, WorkspaceConnectionStatus>;
  setAll: (workspaces: WorkspaceMeta[]) => void;
  upsert: (meta: WorkspaceMeta) => void;
  remove: (id: string) => void;
  setConnectionStatus: (id: string, status: WorkspaceConnectionStatus) => void;
}

interface WorkspacesStoreDeps {
  canUseIpcBridge: () => boolean;
  listen: typeof ipcListen;
}

/**
 * Converts transport lifecycle statuses into compact sidebar display statuses.
 */
function statusFromConnectionEvent(
  status: WorkspaceConnectionEventStatus,
): WorkspaceConnectionStatus {
  return status === "disconnected" ? "idle" : status;
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
 */
function workspaceIsOnline(
  workspace: WorkspaceMeta | undefined,
  status: WorkspaceConnectionStatus,
): boolean {
  if (!workspace) return true;
  if (workspace.location.kind === "local") return true;
  return status === "connected";
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

const defaultWorkspacesStoreDeps: WorkspacesStoreDeps = {
  canUseIpcBridge,
  listen: ipcListen,
};

/**
 * Creates the workspace store with injectable IPC dependencies for tests.
 */
export function createWorkspacesStore(deps: WorkspacesStoreDeps = defaultWorkspacesStoreDeps) {
  return create<WorkspacesState>((set) => {
    // Subscribe to main-process changed events so store stays in sync.
    // `removed` is handled by the central workspace-cleanup registry; only
    // `changed` needs an inline ipcListen here (it's a workspaces-only event,
    // not a generic lifecycle signal).
    if (deps.canUseIpcBridge()) {
      deps.listen("workspace", "changed", (meta) => {
        set((state) => {
          const idx = state.workspaces.findIndex((w) => w.id === meta.id);
          if (idx === -1) {
            // New workspace received via broadcast
            return { workspaces: [...state.workspaces, meta] };
          }
          const next = [...state.workspaces];
          next[idx] = meta;
          return { workspaces: next };
        });
      });
      deps.listen("workspace", "connectionChanged", ({ workspaceId, status }) => {
        set((state) => ({
          connectionStatusByWorkspaceId: {
            ...state.connectionStatusByWorkspaceId,
            [workspaceId]: statusFromConnectionEvent(status),
          },
        }));
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
      }));
    });

    return {
      workspaces: [],
      connectionStatusByWorkspaceId: {},

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
          const idx = state.workspaces.findIndex((w) => w.id === meta.id);
          if (idx === -1) {
            return { workspaces: [...state.workspaces, meta] };
          }
          const next = [...state.workspaces];
          next[idx] = meta;
          return { workspaces: next };
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
    };
  });
}

export const useWorkspacesStore = createWorkspacesStore();
