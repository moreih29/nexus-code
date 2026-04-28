import { createStore, type StoreApi } from "zustand/vanilla";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace/workspace-shell";

export type WorkspaceLayoutSnapshot = Record<string, unknown>;

export interface WorkspaceLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WorkspaceServiceOptions {
  storage?: WorkspaceLayoutStorage | null;
}

export interface WorkspaceServiceSnapshot {
  openWorkspaces: OpenSessionWorkspace[];
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspace: OpenSessionWorkspace | null;
  sideBarCollapsed: boolean;
  layoutByWorkspaceId: Record<string, WorkspaceLayoutSnapshot>;
  activeLayoutModel: WorkspaceLayoutSnapshot | null;
}

export type WorkspaceChangedListener = (
  snapshot: WorkspaceServiceSnapshot,
  previousSnapshot: WorkspaceServiceSnapshot,
) => void;

export interface IWorkspaceService {
  openWorkspaces: OpenSessionWorkspace[];
  activeWorkspaceId: WorkspaceId | null;
  sideBarCollapsed: boolean;
  layoutByWorkspaceId: Record<string, WorkspaceLayoutSnapshot>;
  openWorkspace(workspace: OpenSessionWorkspace): void;
  closeWorkspace(workspaceId: WorkspaceId): void;
  activateWorkspace(workspaceId: WorkspaceId): void;
  getOpenWorkspaces(): OpenSessionWorkspace[];
  getActive(): OpenSessionWorkspace | null;
  getLayoutModel(workspaceId: WorkspaceId): WorkspaceLayoutSnapshot | null;
  saveLayoutModel(workspaceId: WorkspaceId, model: WorkspaceLayoutSnapshot): void;
  onWorkspaceChanged(listener: WorkspaceChangedListener): () => void;
  setSideBarCollapsed(collapsed: boolean): void;
  toggleSideBar(): void;
  persistLayout(workspaceId: WorkspaceId, layout: WorkspaceLayoutSnapshot): void;
  getPersistedLayout(workspaceId: WorkspaceId): WorkspaceLayoutSnapshot | null;
  getActiveWorkspace(): OpenSessionWorkspace | null;
}

export type WorkspaceServiceStore = StoreApi<IWorkspaceService>;
export type WorkspaceServiceState = Pick<
  IWorkspaceService,
  "openWorkspaces" | "activeWorkspaceId" | "sideBarCollapsed" | "layoutByWorkspaceId"
>;

const DEFAULT_WORKSPACE_STATE: WorkspaceServiceState = {
  openWorkspaces: [],
  activeWorkspaceId: null,
  sideBarCollapsed: false,
  layoutByWorkspaceId: {},
};

export function getWorkspaceLayoutStorageKey(workspaceId: WorkspaceId): string {
  return `nx.layout.${workspaceId}`;
}

export function createWorkspaceService(
  initialState: Partial<WorkspaceServiceState> = {},
  options: WorkspaceServiceOptions = {},
): WorkspaceServiceStore {
  const storage = options.storage === undefined ? getDefaultWorkspaceLayoutStorage() : options.storage;
  const initial: WorkspaceServiceState = {
    ...DEFAULT_WORKSPACE_STATE,
    ...initialState,
    openWorkspaces: cloneWorkspaces(initialState.openWorkspaces ?? DEFAULT_WORKSPACE_STATE.openWorkspaces),
    layoutByWorkspaceId: { ...DEFAULT_WORKSPACE_STATE.layoutByWorkspaceId, ...initialState.layoutByWorkspaceId },
  };

  if (initial.activeWorkspaceId && initial.layoutByWorkspaceId[initial.activeWorkspaceId] === undefined) {
    const activeLayout = readLayoutModelFromStorage(storage, initial.activeWorkspaceId);
    if (activeLayout) {
      initial.layoutByWorkspaceId[initial.activeWorkspaceId] = activeLayout;
    }
  }

  return createStore<IWorkspaceService>((set, get, api) => ({
    ...initial,
    openWorkspace(workspace) {
      set((state) => ({
        openWorkspaces: state.openWorkspaces.some((existingWorkspace) => existingWorkspace.id === workspace.id)
          ? state.openWorkspaces.map((existingWorkspace) =>
              existingWorkspace.id === workspace.id ? cloneWorkspace(workspace) : existingWorkspace
            )
          : [...state.openWorkspaces, cloneWorkspace(workspace)],
        activeWorkspaceId: workspace.id,
        layoutByWorkspaceId: hydrateLayoutByWorkspaceId(state.layoutByWorkspaceId, workspace.id, storage),
      }));
    },
    closeWorkspace(workspaceId) {
      removeLayoutModelFromStorage(storage, workspaceId);

      set((state) => {
        const openWorkspaces = state.openWorkspaces.filter((workspace) => workspace.id !== workspaceId);
        const activeWorkspaceId = state.activeWorkspaceId === workspaceId
          ? openWorkspaces[0]?.id ?? null
          : state.activeWorkspaceId;
        const layoutByWorkspaceId = { ...state.layoutByWorkspaceId };
        delete layoutByWorkspaceId[workspaceId];

        return { openWorkspaces, activeWorkspaceId, layoutByWorkspaceId };
      });
    },
    activateWorkspace(workspaceId) {
      if (get().openWorkspaces.some((workspace) => workspace.id === workspaceId)) {
        set((state) => ({
          activeWorkspaceId: workspaceId,
          layoutByWorkspaceId: hydrateLayoutByWorkspaceId(state.layoutByWorkspaceId, workspaceId, storage),
        }));
      }
    },
    getOpenWorkspaces() {
      return cloneWorkspaces(get().openWorkspaces);
    },
    getActive() {
      return get().getActiveWorkspace();
    },
    getLayoutModel(workspaceId) {
      return get().layoutByWorkspaceId[workspaceId] ?? readLayoutModelFromStorage(storage, workspaceId);
    },
    saveLayoutModel(workspaceId, model) {
      const serializedModel = serializeLayoutModel(model);
      if (!serializedModel) {
        return;
      }

      const persistedModel = deserializeLayoutModel(serializedModel);
      if (!persistedModel) {
        return;
      }

      writeLayoutModelToStorage(storage, workspaceId, serializedModel);

      set((state) => ({
        layoutByWorkspaceId: {
          ...state.layoutByWorkspaceId,
          [workspaceId]: persistedModel,
        },
      }));
    },
    onWorkspaceChanged(listener) {
      return api.subscribe((state, previousState) => {
        listener(snapshotWorkspaceState(state), snapshotWorkspaceState(previousState));
      });
    },
    setSideBarCollapsed(collapsed) {
      set({ sideBarCollapsed: collapsed });
    },
    toggleSideBar() {
      set((state) => ({ sideBarCollapsed: !state.sideBarCollapsed }));
    },
    persistLayout(workspaceId, layout) {
      get().saveLayoutModel(workspaceId, layout);
    },
    getPersistedLayout(workspaceId) {
      return get().getLayoutModel(workspaceId);
    },
    getActiveWorkspace() {
      const state = get();
      return state.openWorkspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null;
    },
  }));
}

function hydrateLayoutByWorkspaceId(
  layoutByWorkspaceId: Record<string, WorkspaceLayoutSnapshot>,
  workspaceId: WorkspaceId,
  storage: WorkspaceLayoutStorage | null,
): Record<string, WorkspaceLayoutSnapshot> {
  if (layoutByWorkspaceId[workspaceId] !== undefined) {
    return layoutByWorkspaceId;
  }

  const storedLayout = readLayoutModelFromStorage(storage, workspaceId);
  if (!storedLayout) {
    return layoutByWorkspaceId;
  }

  return {
    ...layoutByWorkspaceId,
    [workspaceId]: storedLayout,
  };
}

function getDefaultWorkspaceLayoutStorage(): WorkspaceLayoutStorage | null {
  try {
    const storage = globalThis.localStorage;

    return isWorkspaceLayoutStorage(storage) ? storage : null;
  } catch {
    return null;
  }
}

function readLayoutModelFromStorage(
  storage: WorkspaceLayoutStorage | null,
  workspaceId: WorkspaceId,
): WorkspaceLayoutSnapshot | null {
  if (!storage) {
    return null;
  }

  try {
    const serializedModel = storage.getItem(getWorkspaceLayoutStorageKey(workspaceId));
    return serializedModel ? deserializeLayoutModel(serializedModel) : null;
  } catch {
    return null;
  }
}

function writeLayoutModelToStorage(
  storage: WorkspaceLayoutStorage | null,
  workspaceId: WorkspaceId,
  serializedModel: string,
): void {
  try {
    storage?.setItem(getWorkspaceLayoutStorageKey(workspaceId), serializedModel);
  } catch {
  }
}

function removeLayoutModelFromStorage(
  storage: WorkspaceLayoutStorage | null,
  workspaceId: WorkspaceId,
): void {
  try {
    storage?.removeItem(getWorkspaceLayoutStorageKey(workspaceId));
  } catch {
  }
}

function serializeLayoutModel(model: WorkspaceLayoutSnapshot): string | null {
  try {
    const serializedModel = JSON.stringify(model);
    return typeof serializedModel === "string" ? serializedModel : null;
  } catch {
    return null;
  }
}

function deserializeLayoutModel(serializedModel: string): WorkspaceLayoutSnapshot | null {
  try {
    const model = JSON.parse(serializedModel);
    return isRecord(model) ? model : null;
  } catch {
    return null;
  }
}

function snapshotWorkspaceState(state: IWorkspaceService): WorkspaceServiceSnapshot {
  const activeWorkspace = getActiveWorkspaceFromState(state.openWorkspaces, state.activeWorkspaceId);

  return {
    openWorkspaces: cloneWorkspaces(state.openWorkspaces),
    activeWorkspaceId: state.activeWorkspaceId,
    activeWorkspace,
    sideBarCollapsed: state.sideBarCollapsed,
    layoutByWorkspaceId: { ...state.layoutByWorkspaceId },
    activeLayoutModel: state.activeWorkspaceId ? state.getLayoutModel(state.activeWorkspaceId) : null,
  };
}

function getActiveWorkspaceFromState(
  openWorkspaces: OpenSessionWorkspace[],
  activeWorkspaceId: WorkspaceId | null,
): OpenSessionWorkspace | null {
  return activeWorkspaceId
    ? openWorkspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
    : null;
}

function cloneWorkspaces(workspaces: readonly OpenSessionWorkspace[]): OpenSessionWorkspace[] {
  return workspaces.map(cloneWorkspace);
}

function cloneWorkspace(workspace: OpenSessionWorkspace): OpenSessionWorkspace {
  return { ...workspace };
}

function isWorkspaceLayoutStorage(value: unknown): value is WorkspaceLayoutStorage {
  return isRecord(value) &&
    typeof value.getItem === "function" &&
    typeof value.setItem === "function" &&
    typeof value.removeItem === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
