import { createStore, type StoreApi } from "zustand/vanilla";

export type DefaultActivityBarViewId =
  | "explorer"
  | "search"
  | "source-control"
  | "tool"
  | "session"
  | "preview";

export type ActivityBarViewId =
  | DefaultActivityBarViewId
  | string;

export type ActivityBarSideBarContentId = DefaultActivityBarViewId | string;

export interface ActivityBarSideBarRoute {
  title: string;
  contentId: ActivityBarSideBarContentId;
}

export interface ActivityBarView {
  id: ActivityBarViewId;
  label: string;
  sideBarTitle: string;
  sideBarContentId: ActivityBarSideBarContentId;
}

export interface RegisterActivityBarViewInput {
  id: ActivityBarViewId;
  label: string;
  sideBarTitle: string;
  sideBarContentId?: ActivityBarSideBarContentId;
}

export interface ActivityBarServiceSnapshot {
  views: ActivityBarView[];
  activeViewId: ActivityBarViewId;
  sideBarCollapsed: boolean;
  sideBarWidth: number;
}

export interface IActivityBarService {
  views: ActivityBarView[];
  activeViewId: ActivityBarViewId;
  sideBarCollapsed: boolean;
  sideBarWidth: number;
  registerView(view: RegisterActivityBarViewInput): void;
  setActiveView(viewId: ActivityBarViewId): void;
  setSideBarCollapsed(collapsed: boolean): void;
  toggleSideBar(): void;
  setSideBarWidth(width: number): void;
  getActiveView(): ActivityBarView | null;
  getActiveSideBarRoute(): ActivityBarSideBarRoute | null;
  getSnapshot(): ActivityBarServiceSnapshot;
  getState(): ActivityBarServiceSnapshot;
}

export type ActivityBarServiceStore = StoreApi<IActivityBarService>;
export type ActivityBarServiceState = ActivityBarServiceSnapshot;

export const DEFAULT_ACTIVITY_BAR_VIEWS: ActivityBarView[] = [
  {
    id: "explorer",
    label: "Explorer",
    sideBarTitle: "Explorer",
    sideBarContentId: "explorer",
  },
  {
    id: "search",
    label: "Search",
    sideBarTitle: "Search",
    sideBarContentId: "search",
  },
  {
    id: "source-control",
    label: "Source Control",
    sideBarTitle: "Source Control",
    sideBarContentId: "source-control",
  },
  {
    id: "tool",
    label: "Tool",
    sideBarTitle: "Tool",
    sideBarContentId: "tool",
  },
  {
    id: "session",
    label: "Session",
    sideBarTitle: "Session",
    sideBarContentId: "session",
  },
  {
    id: "preview",
    label: "Preview",
    sideBarTitle: "Preview",
    sideBarContentId: "preview",
  },
];

export const DEFAULT_SIDE_BAR_WIDTH = 280;

const DEFAULT_ACTIVITY_BAR_STATE: ActivityBarServiceState = {
  views: DEFAULT_ACTIVITY_BAR_VIEWS.map(cloneActivityBarView),
  activeViewId: "explorer",
  sideBarCollapsed: false,
  sideBarWidth: DEFAULT_SIDE_BAR_WIDTH,
};

export function createActivityBarService(
  initialState: Partial<ActivityBarServiceState> = {},
): ActivityBarServiceStore {
  const state = createActivityBarInitialState(initialState);

  return createStore<IActivityBarService>((set, get) => ({
    ...state,
    registerView(view) {
      set((state) => ({
        views: state.views.some((existingView) => existingView.id === view.id)
          ? state.views.map((existingView) =>
            existingView.id === view.id
              ? normalizeActivityBarView(view, existingView.sideBarContentId)
              : existingView
          )
          : [...state.views, normalizeActivityBarView(view)],
      }));
    },
    setActiveView(viewId) {
      if (get().views.some((view) => view.id === viewId)) {
        set({ activeViewId: viewId });
      }
    },
    setSideBarCollapsed(collapsed) {
      set({ sideBarCollapsed: collapsed });
    },
    toggleSideBar() {
      set((state) => ({ sideBarCollapsed: !state.sideBarCollapsed }));
    },
    setSideBarWidth(width) {
      set({ sideBarWidth: width });
    },
    getActiveView() {
      const state = get();
      return state.views.find((view) => view.id === state.activeViewId) ?? null;
    },
    getActiveSideBarRoute() {
      const activeView = get().getActiveView();
      return activeView
        ? { title: activeView.sideBarTitle, contentId: activeView.sideBarContentId }
        : null;
    },
    getSnapshot() {
      return createActivityBarSnapshot(get());
    },
    getState() {
      return createActivityBarSnapshot(get());
    },
  }));
}

function createActivityBarInitialState(
  initialState: Partial<ActivityBarServiceState>,
): ActivityBarServiceState {
  const views = (initialState.views ?? DEFAULT_ACTIVITY_BAR_STATE.views)
    .map((view) => normalizeActivityBarView(view));
  const requestedActiveViewId = initialState.activeViewId ?? DEFAULT_ACTIVITY_BAR_STATE.activeViewId;
  const fallbackActiveViewId = views.find((view) => view.id === DEFAULT_ACTIVITY_BAR_STATE.activeViewId)?.id
    ?? views[0]?.id
    ?? DEFAULT_ACTIVITY_BAR_STATE.activeViewId;

  return {
    views,
    activeViewId: views.some((view) => view.id === requestedActiveViewId)
      ? requestedActiveViewId
      : fallbackActiveViewId,
    sideBarCollapsed: initialState.sideBarCollapsed ?? DEFAULT_ACTIVITY_BAR_STATE.sideBarCollapsed,
    sideBarWidth: initialState.sideBarWidth ?? DEFAULT_ACTIVITY_BAR_STATE.sideBarWidth,
  };
}

function normalizeActivityBarView(
  view: RegisterActivityBarViewInput,
  fallbackSideBarContentId?: ActivityBarSideBarContentId,
): ActivityBarView {
  return {
    ...view,
    sideBarContentId: view.sideBarContentId ?? fallbackSideBarContentId ?? view.id,
  };
}

function createActivityBarSnapshot(state: ActivityBarServiceSnapshot): ActivityBarServiceSnapshot {
  return {
    views: state.views.map(cloneActivityBarView),
    activeViewId: state.activeViewId,
    sideBarCollapsed: state.sideBarCollapsed,
    sideBarWidth: state.sideBarWidth,
  };
}

function cloneActivityBarView(view: ActivityBarView): ActivityBarView {
  return { ...view };
}
