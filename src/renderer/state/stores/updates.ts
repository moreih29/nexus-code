// src/renderer/state/stores/updates.ts — Update preferences UI state.
//
// Thin zustand store that mirrors the AppState `updateChannel` and
// `autoCheckForUpdates` fields in the renderer so the Settings panel can read
// and optimistically update them without prop drilling through App.tsx.
//
// Hydrated by `bootstrapAppState` after the first `appState.get` call.
// Persisted back to main via `appState.set` from the About panel.

import { create } from "zustand";

type UpdateChannel = "stable" | "beta";

interface UpdatesState {
  /** Current update channel. Defaults to "stable" until hydrated from appState. */
  channel: UpdateChannel;
  /** Auto-check toggle. Defaults to true until hydrated from appState. */
  autoCheckEnabled: boolean;
  /** Hydrate from persisted appState on bootstrap. */
  hydrate(input: {
    channel: UpdateChannel | undefined;
    autoCheckEnabled: boolean | undefined;
  }): void;
  /** Set channel locally (component calls this for optimistic updates). */
  setChannel(channel: UpdateChannel): void;
  /** Set auto-check toggle locally (component calls this for optimistic updates). */
  setAutoCheckEnabled(enabled: boolean): void;
}

export const useUpdatesStore = create<UpdatesState>((set) => ({
  channel: "stable",
  autoCheckEnabled: true,

  hydrate({ channel, autoCheckEnabled }) {
    set({
      channel: channel ?? "stable",
      autoCheckEnabled: autoCheckEnabled ?? true,
    });
  },

  setChannel(channel) {
    set({ channel });
  },

  setAutoCheckEnabled(autoCheckEnabled) {
    set({ autoCheckEnabled });
  },
}));
