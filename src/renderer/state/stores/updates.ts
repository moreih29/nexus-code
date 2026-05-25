// src/renderer/state/stores/updates.ts — Update channel UI state.
//
// Thin zustand store that mirrors the AppState `updateChannel` field in the
// renderer so the Settings panel can read and optimistically update it without
// prop drilling through App.tsx.
//
// Hydrated by `bootstrapAppState` after the first `appState.get` call.
// Persisted back to main via `appState.set` in the UpdatesPanel component.

import { create } from "zustand";

type UpdateChannel = "stable" | "beta";

interface UpdatesState {
  /** Current update channel. Defaults to "stable" until hydrated from appState. */
  channel: UpdateChannel;
  /** Hydrate from persisted appState on bootstrap. */
  hydrate(channel: UpdateChannel | undefined): void;
  /** Set channel locally (component calls this for optimistic updates). */
  setChannel(channel: UpdateChannel): void;
}

export const useUpdatesStore = create<UpdatesState>((set) => ({
  channel: "stable",

  hydrate(channel) {
    set({ channel: channel ?? "stable" });
  },

  setChannel(channel) {
    set({ channel });
  },
}));
