// src/renderer/state/stores/mounted-workspaces.ts — Workspaces whose panel is mounted.
//
// Every workspace activated in this session, and the tasks nexus starts
// behind the user's view. A mounted panel stays (hidden while inactive), so
// its terminals keep running; an unmounted one has none started.

import { create } from "zustand";

interface MountedWorkspacesState {
  ids: ReadonlySet<string>;
  mount(id: string): void;
  /** Drops the workspaces that are gone. */
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
