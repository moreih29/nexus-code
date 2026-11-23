import { create } from "zustand";

interface MountedWorkspacesState {
  ids: ReadonlySet<string>;
  mount(id: string): void;
  keepOnly(alive: ReadonlySet<string>): void;
}

export const useMountedWorkspacesStore = create<MountedWorkspacesState>((set) => ({
  ids: new Set(),

  mount(id) {
    set((state) => (state.ids.has(id) ? state : { ids: new Set(state.ids).add(id) }));
  },

  keepOnly(alive) {
    set((state) => {
      const next = new Set([...state.ids].filter((id) => alive.has(id)));
      return next.size === state.ids.size ? state : { ids: next };
    });
  },
}));
