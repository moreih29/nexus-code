import { createStore, type StoreApi } from "zustand/vanilla";

export type BottomPanelPosition = "left" | "right" | "top" | "bottom";
export type BottomPanelViewId = "terminal" | "output" | "problems" | string;
export type BottomPanelHeightPersistenceKey = string;

export interface BottomPanelView {
  id: BottomPanelViewId;
  label: string;
}

export interface BottomPanelServiceSnapshot {
  views: BottomPanelView[];
  activeViewId: BottomPanelViewId | null;
  position: BottomPanelPosition;
  expanded: boolean;
  height: number;
  heightPersistenceKey: BottomPanelHeightPersistenceKey | null;
  heightByPersistenceKey: Record<BottomPanelHeightPersistenceKey, number>;
}

export type BottomPanelStateChangeListener = (
  snapshot: BottomPanelServiceSnapshot,
  previousSnapshot: BottomPanelServiceSnapshot,
) => void;

export interface IBottomPanelService extends BottomPanelServiceSnapshot {
  registerView(view: BottomPanelView): void;
  unregisterView(viewId: BottomPanelViewId): void;
  setActiveView(viewId: BottomPanelViewId): void;
  setPosition(position: BottomPanelPosition): void;
  togglePanel(): void;
  setHeight(height: number, persistenceKey?: BottomPanelHeightPersistenceKey | null): void;
  setHeightPersistenceKey(persistenceKey: BottomPanelHeightPersistenceKey | null): void;
  getSnapshot(): BottomPanelServiceSnapshot;
  onStateChanged(listener: BottomPanelStateChangeListener): () => void;
  getActiveView(): BottomPanelView | null;
  activateView(viewId: BottomPanelViewId): void;
  setExpanded(expanded: boolean): void;
  toggle(): void;
  moveTo(position: BottomPanelPosition): void;
}

export type BottomPanelServiceStore = StoreApi<IBottomPanelService>;
export type BottomPanelServiceState = BottomPanelServiceSnapshot;

export const DEFAULT_BOTTOM_PANEL_HEIGHT = 320;

export const DEFAULT_BOTTOM_PANEL_VIEWS: BottomPanelView[] = [
  { id: "terminal", label: "Terminal" },
  { id: "output", label: "Output" },
  { id: "problems", label: "Problems" },
];

export function createBottomPanelService(
  initialState: Partial<BottomPanelServiceState> = {},
): BottomPanelServiceStore {
  const defaultState = createDefaultBottomPanelState();
  const initialViews = cloneViews(initialState.views ?? defaultState.views);
  const initialHeightByPersistenceKey = {
    ...defaultState.heightByPersistenceKey,
    ...initialState.heightByPersistenceKey,
  };
  const initialHeightPersistenceKey = initialState.heightPersistenceKey ?? defaultState.heightPersistenceKey;
  const initialHeight = initialHeightPersistenceKey
    ? initialHeightByPersistenceKey[initialHeightPersistenceKey] ?? initialState.height ?? defaultState.height
    : initialState.height ?? defaultState.height;
  const initialActiveViewId = normalizeActiveViewId(
    initialViews,
    initialState.activeViewId ?? defaultState.activeViewId,
  );
  const initial: BottomPanelServiceState = {
    views: initialViews,
    activeViewId: initialActiveViewId,
    position: initialState.position ?? defaultState.position,
    expanded: initialState.expanded ?? defaultState.expanded,
    height: normalizeHeight(initialHeight),
    heightPersistenceKey: initialHeightPersistenceKey,
    heightByPersistenceKey: initialHeightByPersistenceKey,
  };

  return createStore<IBottomPanelService>((set, get, api) => ({
    ...initial,
    registerView(view) {
      set((state) => {
        const views = state.views.some((existingView) => existingView.id === view.id)
          ? state.views.map((existingView) => existingView.id === view.id ? { ...view } : existingView)
          : [...state.views, { ...view }];

        return {
          views,
          activeViewId: state.activeViewId ?? view.id,
        };
      });
    },
    unregisterView(viewId) {
      set((state) => {
        const views = state.views.filter((view) => view.id !== viewId);
        if (views.length === state.views.length) {
          return {};
        }

        return {
          views,
          activeViewId: state.activeViewId === viewId ? views[0]?.id ?? null : state.activeViewId,
        };
      });
    },
    setActiveView(viewId) {
      if (get().views.some((view) => view.id === viewId)) {
        set({ activeViewId: viewId, expanded: true });
      }
    },
    setPosition(position) {
      set({ position });
    },
    togglePanel() {
      set((state) => ({ expanded: !state.expanded }));
    },
    setHeight(height, persistenceKey) {
      const normalizedHeight = normalizeHeight(height);
      set((state) => {
        const heightPersistenceKey = persistenceKey === undefined ? state.heightPersistenceKey : persistenceKey;

        return {
          height: normalizedHeight,
          heightPersistenceKey,
          heightByPersistenceKey: heightPersistenceKey
            ? {
                ...state.heightByPersistenceKey,
                [heightPersistenceKey]: normalizedHeight,
              }
            : state.heightByPersistenceKey,
        };
      });
    },
    setHeightPersistenceKey(persistenceKey) {
      set((state) => ({
        heightPersistenceKey: persistenceKey,
        height: persistenceKey
          ? state.heightByPersistenceKey[persistenceKey] ?? DEFAULT_BOTTOM_PANEL_HEIGHT
          : state.height,
      }));
    },
    getSnapshot() {
      return snapshotBottomPanelState(get());
    },
    onStateChanged(listener) {
      return api.subscribe((state, previousState) => {
        listener(snapshotBottomPanelState(state), snapshotBottomPanelState(previousState));
      });
    },
    getActiveView() {
      const state = get();
      const activeView = state.activeViewId
        ? state.views.find((view) => view.id === state.activeViewId)
        : null;

      return activeView ? { ...activeView } : null;
    },
    activateView(viewId) {
      get().setActiveView(viewId);
    },
    setExpanded(expanded) {
      set({ expanded });
    },
    toggle() {
      get().togglePanel();
    },
    moveTo(position) {
      get().setPosition(position);
    },
  }));
}

function createDefaultBottomPanelState(): BottomPanelServiceState {
  return {
    views: cloneViews(DEFAULT_BOTTOM_PANEL_VIEWS),
    activeViewId: "terminal",
    position: "bottom",
    expanded: true,
    height: DEFAULT_BOTTOM_PANEL_HEIGHT,
    heightPersistenceKey: null,
    heightByPersistenceKey: {},
  };
}

function normalizeActiveViewId(
  views: BottomPanelView[],
  activeViewId: BottomPanelViewId | null,
): BottomPanelViewId | null {
  if (activeViewId && views.some((view) => view.id === activeViewId)) {
    return activeViewId;
  }

  return views[0]?.id ?? null;
}

function normalizeHeight(height: number): number {
  return Number.isFinite(height) && height > 0 ? Math.round(height) : DEFAULT_BOTTOM_PANEL_HEIGHT;
}

function snapshotBottomPanelState(state: BottomPanelServiceState): BottomPanelServiceSnapshot {
  return {
    views: cloneViews(state.views),
    activeViewId: state.activeViewId,
    position: state.position,
    expanded: state.expanded,
    height: state.height,
    heightPersistenceKey: state.heightPersistenceKey,
    heightByPersistenceKey: { ...state.heightByPersistenceKey },
  };
}

function cloneViews(views: readonly BottomPanelView[]): BottomPanelView[] {
  return views.map((view) => ({ ...view }));
}
